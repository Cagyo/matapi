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
import { parseTrustedState, type TrustedState } from "../domain/ota-contracts";
import {
  TrustedStateLostError,
  type TrustedStateCommit,
  type TrustedStatePort,
} from "../domain/ports/trusted-state.port";
import { parseOuterEnvelope } from "../domain/signed-manifest";
import { parseStrictJson } from "../domain/strict-json";

const MAX_SLOT_BYTES = 2 * 1024 * 1024;
const SLOT_NAMES = {
  a: "trusted-state-a.json",
  b: "trusted-state-b.json",
} as const;

type SlotName = keyof typeof SLOT_NAMES;
type JsonRecord = Record<string, unknown>;

interface LoadedSlot {
  name: SlotName;
  state: TrustedState;
}

export interface TrustedStateFaultHooks {
  afterTempFileSync?(path: string): void | Promise<void>;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  return value as JsonRecord;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalPayload(state: TrustedStateCommit): TrustedStateCommit {
  return {
    schemaVersion: state.schemaVersion,
    generation: state.generation,
    writtenAt: state.writtenAt,
    highestMetadata: {
      metadataVersion: state.highestMetadata.metadataVersion,
      payloadSha256: state.highestMetadata.payloadSha256,
    },
    envelope: {
      bytes: state.envelope.bytes,
      etag: state.envelope.etag,
    },
    timeAnchor: {
      wallMs: state.timeAnchor.wallMs,
      monotonicMs: state.timeAnchor.monotonicMs,
      bootId: state.timeAnchor.bootId,
      persistedAtMs: state.timeAnchor.persistedAtMs,
    },
    artifacts: state.artifacts.map((artifact) => ({
      version: artifact.version,
      artifactSha256: artifact.artifactSha256,
      firstMetadataSha256: artifact.firstMetadataSha256,
    })),
    lastNotification:
      state.lastNotification === null
        ? null
        : {
            version: state.lastNotification.version,
            artifactSha256: state.lastNotification.artifactSha256,
          },
    failureDays: state.failureDays.map((failureDay) => ({
      day: failureDay.day,
      codes: [...failureDay.codes],
    })),
  };
}

function checksummed(state: TrustedStateCommit): TrustedState {
  const payload = canonicalPayload(state);
  return parseTrustedState({
    ...payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  });
}

function validateEnvelopeRelationship(state: TrustedState): void {
  if (!/^"[^"\r\n]*"$/.test(state.envelope.etag))
    throw new Error("trusted-state envelope ETag is not strong");

  const outerBytes = Buffer.from(state.envelope.bytes, "base64");
  const outer = parseOuterEnvelope(outerBytes);
  if (sha256(outer.payloadBytes) !== state.highestMetadata.payloadSha256) {
    throw new Error("trusted-state envelope payload digest mismatch");
  }

  const manifest = asRecord(
    parseStrictJson(outer.payloadBytes),
    "trusted-state envelope payload",
  );
  if (manifest.schemaVersion !== 1)
    throw new Error("trusted-state envelope schemaVersion mismatch");
  if (manifest.metadataVersion !== state.highestMetadata.metadataVersion) {
    throw new Error("trusted-state envelope metadataVersion mismatch");
  }
  if (typeof manifest.version !== "string")
    throw new Error("trusted-state envelope version is malformed");
  const artifact = asRecord(
    manifest.artifact,
    "trusted-state envelope artifact",
  );
  if (typeof artifact.sha256 !== "string")
    throw new Error("trusted-state envelope artifact digest is malformed");

  const ledger = new Map<string, string>();
  for (const entry of state.artifacts) {
    if (ledger.has(entry.version))
      throw new Error("trusted-state artifact ledger contains duplicates");
    ledger.set(entry.version, entry.artifactSha256);
  }
  if (ledger.get(manifest.version) !== artifact.sha256) {
    throw new Error("trusted-state envelope is absent from artifact ledger");
  }
  if (
    state.lastNotification !== null &&
    ledger.get(state.lastNotification.version) !==
      state.lastNotification.artifactSha256
  ) {
    throw new Error("trusted-state last notification is absent from ledger");
  }
}

function artifactLedger(
  state: TrustedState,
): Map<string, { artifactSha256: string; firstMetadataSha256: string }> {
  return new Map(
    state.artifacts.map((artifact) => [
      artifact.version,
      {
        artifactSha256: artifact.artifactSha256,
        firstMetadataSha256: artifact.firstMetadataSha256,
      },
    ]),
  );
}

function validateStateTransition(
  current: TrustedState,
  next: TrustedState,
): void {
  if (next.generation <= current.generation)
    throw new Error("trusted-state generation must advance");
  if (
    next.highestMetadata.metadataVersion <
    current.highestMetadata.metadataVersion
  ) {
    throw new Error("trusted-state metadata rollback");
  }
  if (
    next.highestMetadata.metadataVersion ===
      current.highestMetadata.metadataVersion &&
    next.highestMetadata.payloadSha256 !== current.highestMetadata.payloadSha256
  ) {
    throw new Error("trusted-state metadata equivocation");
  }

  const currentLedger = artifactLedger(current);
  const nextLedger = artifactLedger(next);
  for (const [version, identity] of currentLedger) {
    const retained = nextLedger.get(version);
    if (
      retained?.artifactSha256 !== identity.artifactSha256 ||
      retained?.firstMetadataSha256 !== identity.firstMetadataSha256
    ) {
      throw new Error("trusted-state artifact ledger history changed");
    }
  }

  if (
    next.timeAnchor.wallMs < current.timeAnchor.wallMs ||
    next.timeAnchor.persistedAtMs < current.timeAnchor.persistedAtMs
  ) {
    throw new Error("trusted-state time floor regressed");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > MAX_SLOT_BYTES)
    throw new Error("trusted-state slot is invalid or oversized");
  const buffer = Buffer.allocUnsafe(MAX_SLOT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_SLOT_BYTES)
    throw new Error("trusted-state slot exceeds 2 MiB");
  return buffer.subarray(0, offset);
}

export class DualSlotTrustedStateAdapter implements TrustedStatePort {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly hooks: TrustedStateFaultHooks = {},
  ) {}

  async load(): Promise<TrustedState> {
    return (await this.loadSelected()).state;
  }

  async commit(state: TrustedStateCommit): Promise<TrustedState> {
    return this.serializeMutation(() => this.commitExclusive(state));
  }

  private async commitExclusive(
    state: TrustedStateCommit,
  ): Promise<TrustedState> {
    const current = await this.loadSelected();
    const next = checksummed(state);
    validateEnvelopeRelationship(next);
    validateStateTransition(current.state, next);
    const target: SlotName = current.name === "a" ? "b" : "a";
    await this.writeSlot(target, next);
    return next;
  }

  /** Maintenance/bootstrap only. It never overwrites existing state. */
  async seed(state: TrustedStateCommit): Promise<TrustedState> {
    return this.serializeMutation(() => this.seedExclusive(state));
  }

  private async seedExclusive(
    state: TrustedStateCommit,
  ): Promise<TrustedState> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (
      (await pathExists(this.slotPath("a"))) ||
      (await pathExists(this.slotPath("b")))
    ) {
      throw new Error("trusted-state seed refused existing slots");
    }
    const baseline = checksummed(state);
    validateEnvelopeRelationship(baseline);
    await this.writeSlot("a", baseline);
    await this.writeSlot("b", baseline);
    return baseline;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private slotPath(name: SlotName): string {
    return resolve(this.directory, SLOT_NAMES[name]);
  }

  private async readSlot(name: SlotName): Promise<LoadedSlot | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.slotPath(name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const state = parseTrustedState(await readBounded(handle));
      validateEnvelopeRelationship(state);
      return { name, state };
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  private async loadSelected(): Promise<LoadedSlot> {
    const slots = (
      await Promise.all([this.readSlot("a"), this.readSlot("b")])
    ).filter((slot): slot is LoadedSlot => slot !== null);
    if (slots.length === 0) throw new TrustedStateLostError();
    if (
      slots.length === 2 &&
      slots[0].state.generation === slots[1].state.generation &&
      slots[0].state.checksum !== slots[1].state.checksum
    ) {
      throw new TrustedStateLostError();
    }
    slots.sort(
      (left, right) =>
        left.state.generation - right.state.generation ||
        left.name.localeCompare(right.name),
    );
    if (
      slots.length === 2 &&
      slots[0].state.generation !== slots[1].state.generation
    ) {
      try {
        validateStateTransition(slots[0].state, slots[1].state);
      } catch {
        return slots[0];
      }
    }
    return slots.at(-1)!;
  }

  private async writeSlot(name: SlotName, state: TrustedState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
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
      await handle.writeFile(Buffer.from(JSON.stringify(state), "utf8"));
      await handle.sync();
      await this.hooks.afterTempFileSync?.(temporary);
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      renamed = true;

      const directoryHandle = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close();
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }
}
