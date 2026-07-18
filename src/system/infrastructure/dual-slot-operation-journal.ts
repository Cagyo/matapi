import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  canTransitionOperationState,
  parseOperationJournal,
  preservesOperationImmutables,
  type CheckedReleaseIdentity,
  type OperationDiagnostics,
  type OperationJournal,
  type OperationPhase,
} from "../domain/ota-contracts";

const MAX_SLOT_BYTES = 2 * 1024 * 1024;
const SLOT_NAMES = {
  a: "operation-a.json",
  b: "operation-b.json",
} as const;

type SlotName = keyof typeof SLOT_NAMES;

export type OperationJournalInput = Omit<
  OperationJournal,
  "generation" | "checksum"
>;

export type OperationJournalTransitionUpdate = Partial<
  Pick<
    OperationJournalInput,
    "preparedTreeSha256" | "diagnostics" | "updatedAt"
  >
>;

export interface OperationJournalFaultHooks {
  afterTempFileSync?(path: string): void | Promise<void>;
}

interface LoadedSlot {
  name: SlotName;
  journal: OperationJournal;
}

type SlotResult =
  | { kind: "missing" }
  | { kind: "corrupt" }
  | { kind: "valid"; slot: LoadedSlot };

class CorruptOperationSlotError extends Error {}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function canonicalExpected(
  expected: CheckedReleaseIdentity | null,
): CheckedReleaseIdentity | null {
  if (expected === null) return null;
  return {
    artifact: {
      version: expected.artifact.version,
      commit: expected.artifact.commit,
      targetName: expected.artifact.targetName,
      target: {
        platform: expected.artifact.target.platform,
        arch: expected.artifact.target.arch,
        libc: expected.artifact.target.libc,
        libcMinVersion: expected.artifact.target.libcMinVersion,
        nodeModulesAbi: expected.artifact.target.nodeModulesAbi,
      },
      url: expected.artifact.url,
      format: expected.artifact.format,
      size: expected.artifact.size,
      expandedSize: expected.artifact.expandedSize,
      maxPreparedSize: expected.artifact.maxPreparedSize,
      maxPreparedFiles: expected.artifact.maxPreparedFiles,
      fileCount: expected.artifact.fileCount,
      sha256: expected.artifact.sha256,
    },
    metadata: {
      metadataVersion: expected.metadata.metadataVersion,
      channel: expected.metadata.channel,
      payloadSha256: expected.metadata.payloadSha256,
      publishedAt: expected.metadata.publishedAt,
      expiresAt: expected.metadata.expiresAt,
    },
  };
}

function canonicalDiagnostics(
  diagnostics: OperationDiagnostics,
): OperationDiagnostics {
  return { code: diagnostics.code, notes: [...diagnostics.notes] };
}

function canonicalPayload(
  input: OperationJournalInput,
  generation: number,
): Omit<OperationJournal, "checksum"> {
  return {
    schemaVersion: input.schemaVersion,
    generation,
    operationId: input.operationId,
    kind: input.kind,
    phase: input.phase,
    expected: canonicalExpected(input.expected),
    acceptedAt: input.acceptedAt,
    requestSha256: input.requestSha256,
    receiptGeneration: input.receiptGeneration,
    priorCurrent: input.priorCurrent,
    priorPrevious: input.priorPrevious,
    candidate: input.candidate,
    preparedTreeSha256: input.preparedTreeSha256,
    diagnostics: canonicalDiagnostics(input.diagnostics),
    updatedAt: input.updatedAt,
  };
}

function checksummed(
  input: OperationJournalInput,
  generation: number,
): OperationJournal {
  const payload = canonicalPayload(input, generation);
  const document: OperationJournal = {
    ...payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  };
  parseOperationJournal(document);
  return document;
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const slot = await handle.stat();
  if (!slot.isFile() || slot.size > MAX_SLOT_BYTES) {
    throw new CorruptOperationSlotError("operation journal slot is invalid");
  }
  const bytes = Buffer.allocUnsafe(MAX_SLOT_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_SLOT_BYTES) {
    throw new CorruptOperationSlotError("operation journal slot is oversized");
  }
  return bytes.subarray(0, offset);
}

function validatesTransition(
  previous: OperationJournal,
  next: OperationJournal,
): boolean {
  return (
    next.generation === previous.generation + 1 &&
    canTransitionOperationState(previous.phase, next.phase) &&
    preservesOperationImmutables(previous, next)
  );
}

export class DualSlotOperationJournal {
  constructor(
    private readonly directory: string,
    private readonly hooks: OperationJournalFaultHooks = {},
  ) {}

  async load(): Promise<OperationJournal | null> {
    const selected = await this.loadSelected();
    return selected?.journal ?? null;
  }

  async start(input: OperationJournalInput): Promise<OperationJournal> {
    if (input.phase !== "preparing") {
      throw new Error("operation journal must start in preparing phase");
    }
    await this.validateDirectory(true);
    const slots = await Promise.all([this.readSlot("a"), this.readSlot("b")]);
    if (slots.some((slot) => slot.kind !== "missing")) {
      throw new Error("operation journal start refused existing slots");
    }
    const journal = checksummed(input, 1);
    await this.writeSlot("a", journal);
    await this.writeSlot("b", journal);
    return journal;
  }

  async transition(
    current: OperationJournal,
    phase: OperationPhase,
    update: OperationJournalTransitionUpdate = {},
  ): Promise<OperationJournal> {
    const supplied = parseOperationJournal(current);
    if (!canTransitionOperationState(supplied.phase, phase)) {
      throw new Error(
        `illegal operation journal transition ${supplied.phase} -> ${phase}`,
      );
    }
    const selected = await this.loadSelected();
    if (selected === null) throw new Error("operation journal is missing");
    if (
      selected.journal.generation !== supplied.generation ||
      selected.journal.checksum !== supplied.checksum
    ) {
      throw new Error("operation journal transition used stale state");
    }

    const next = checksummed(
      {
        schemaVersion: selected.journal.schemaVersion,
        operationId: selected.journal.operationId,
        kind: selected.journal.kind,
        phase,
        expected: selected.journal.expected,
        acceptedAt: selected.journal.acceptedAt,
        requestSha256: selected.journal.requestSha256,
        receiptGeneration: selected.journal.receiptGeneration,
        priorCurrent: selected.journal.priorCurrent,
        priorPrevious: selected.journal.priorPrevious,
        candidate: selected.journal.candidate,
        preparedTreeSha256:
          update.preparedTreeSha256 ?? selected.journal.preparedTreeSha256,
        diagnostics: update.diagnostics ?? selected.journal.diagnostics,
        updatedAt: update.updatedAt ?? selected.journal.updatedAt,
      },
      selected.journal.generation + 1,
    );
    if (!validatesTransition(selected.journal, next)) {
      throw new Error("operation journal transition is invalid");
    }
    const target: SlotName = selected.name === "a" ? "b" : "a";
    await this.writeSlot(target, next);
    return next;
  }

  private slotPath(name: SlotName): string {
    return resolve(this.directory, SLOT_NAMES[name]);
  }

  private async validateDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let directory;
    try {
      directory = await lstat(this.directory);
    } catch (error) {
      if (!create && errno(error) === "ENOENT") return;
      throw error;
    }
    const expectedUid = process.getuid?.();
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      (directory.mode & 0o777) !== 0o700 ||
      (expectedUid !== undefined && directory.uid !== expectedUid)
    ) {
      throw new Error(
        "operation journal directory must be owned, non-symlink, and mode 0700",
      );
    }
  }

  private async readSlot(name: SlotName): Promise<SlotResult> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.slotPath(name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (errno(error) === "ENOENT") return { kind: "missing" };
      if (errno(error) === "ELOOP") return { kind: "corrupt" };
      throw error;
    }
    let bytes: Buffer;
    try {
      bytes = await readBounded(handle);
    } catch (error) {
      if (error instanceof CorruptOperationSlotError) {
        return { kind: "corrupt" };
      }
      throw error;
    } finally {
      await handle.close();
    }
    try {
      const parsed = parseOperationJournal(bytes);
      return {
        kind: "valid",
        slot: {
          name,
          journal: {
            ...canonicalPayload(parsed, parsed.generation),
            checksum: parsed.checksum,
          },
        },
      };
    } catch {
      return { kind: "corrupt" };
    }
  }

  private async loadSelected(): Promise<LoadedSlot | null> {
    await this.validateDirectory(false);
    const results = await Promise.all([this.readSlot("a"), this.readSlot("b")]);
    if (results.every((result) => result.kind === "missing")) return null;
    const slots = results.flatMap((result) =>
      result.kind === "valid" ? [result.slot] : [],
    );
    if (slots.length === 0) throw new Error("operation journal lost");
    if (
      slots.length === 2 &&
      slots[0].journal.generation === slots[1].journal.generation &&
      slots[0].journal.checksum !== slots[1].journal.checksum
    ) {
      throw new Error("operation journal lost");
    }
    slots.sort(
      (left, right) =>
        left.journal.generation - right.journal.generation ||
        left.name.localeCompare(right.name),
    );
    if (
      slots.length === 2 &&
      slots[0].journal.generation !== slots[1].journal.generation &&
      !validatesTransition(slots[0].journal, slots[1].journal)
    ) {
      return slots[0];
    }
    return slots.at(-1)!;
  }

  private async writeSlot(
    name: SlotName,
    journal: OperationJournal,
  ): Promise<void> {
    await this.validateDirectory(false);
    const target = this.slotPath(name);
    const temporary = resolve(
      this.directory,
      `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let handle: FileHandle | undefined;
    let renamed = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(Buffer.from(JSON.stringify(journal), "utf8"));
      await handle.sync();
      await this.hooks.afterTempFileSync?.(temporary);
      await handle.close();
      handle = undefined;
      await this.validateDirectory(false);
      await rename(temporary, target);
      renamed = true;

      const directory = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close();
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }
}
