import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CheckedReleaseIdentity,
  OperationJournal,
  OperationPhase,
} from "../../../src/system/domain/ota-contracts";
import {
  DualSlotOperationJournal,
  type OperationJournalInput,
} from "../../../src/system/infrastructure/dual-slot-operation-journal";

const roots: string[] = [];
const RELEASE_NAME = `1.4.2-${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(resolve(tmpdir(), "operation-journal-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function checkedRelease(): CheckedReleaseIdentity {
  return {
    artifact: {
      version: "1.4.2",
      commit: "0123456789abcdef0123456789abcdef01234567",
      targetName: "linux-armv7-glibc",
      target: {
        platform: "linux",
        arch: "arm",
        libc: "glibc",
        libcMinVersion: "2.28",
        nodeModulesAbi: "115",
      },
      url: "https://updates.example.test/home-worker-1.4.2.tar.gz",
      format: "tar.gz",
      size: 10,
      expandedSize: 20,
      maxPreparedSize: 30,
      maxPreparedFiles: 40,
      fileCount: 2,
      sha256: "a".repeat(64),
    },
    metadata: {
      metadataVersion: 42,
      channel: "stable",
      payloadSha256: "b".repeat(64),
      publishedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-02T00:00:00.000Z",
    },
  };
}

function operation(phase: OperationPhase = "preparing"): OperationJournalInput {
  return {
    schemaVersion: 1,
    operationId: "AAAAAAAAAAAAAAAAAAAAAA",
    kind: "update",
    phase,
    expected: checkedRelease(),
    priorCurrent: `1.4.1-${"c".repeat(64)}`,
    priorPrevious: `1.4.0-${"d".repeat(64)}`,
    candidate: RELEASE_NAME,
    preparedTreeSha256: null,
    diagnostics: { code: null, notes: [] },
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

function slot(root: string, name: "a" | "b"): string {
  return resolve(root, `operation-${name}.json`);
}

function readSlots(root: string): OperationJournal[] {
  return (["a", "b"] as const).map(
    (name) =>
      JSON.parse(readFileSync(slot(root, name), "utf8")) as OperationJournal,
  );
}

function checksummed(value: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...value };
  delete payload.checksum;
  return {
    ...payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  };
}

async function operationAtPhase(
  journal: DualSlotOperationJournal,
  phase: "preparing" | "prepared" | "healthy",
): Promise<OperationJournal> {
  const preparing = await journal.start(operation());
  if (phase === "preparing") return preparing;
  const prepared = await journal.transition(preparing, "prepared");
  if (phase === "prepared") return prepared;
  const activating = await journal.transition(prepared, "activating");
  const activated = await journal.transition(activating, "activated");
  return journal.transition(activated, "healthy");
}

describe("DualSlotOperationJournal", () => {
  it("starts a durable generation-one pair and loads it", async () => {
    const root = directory();
    const journal = new DualSlotOperationJournal(root);

    const started = await journal.start(operation());

    expect(started.generation).toBe(1);
    expect(await journal.load()).toEqual(started);
    expect(readSlots(root)[0]).toEqual(readSlots(root)[1]);
  });

  it.each([
    ["preparing", "activated"],
    ["prepared", "healthy"],
    ["healthy", "activating"],
  ] as const)("rejects illegal %s -> %s transition", async (from, to) => {
    const journal = new DualSlotOperationJournal(directory());
    const current = await operationAtPhase(journal, from);

    await expect(journal.transition(current, to)).rejects.toThrow(
      /transition/i,
    );
  });

  it("advances only legal phases while preserving immutable operation identity", async () => {
    const journal = new DualSlotOperationJournal(directory());
    const preparing = await journal.start(operation());
    const prepared = await journal.transition(preparing, "prepared", {
      preparedTreeSha256: "e".repeat(64),
      diagnostics: { code: null, notes: ["candidate prepared"] },
      updatedAt: "2030-01-01T00:00:01.000Z",
    });

    expect(prepared).toMatchObject({
      generation: 2,
      phase: "prepared",
      operationId: preparing.operationId,
      kind: preparing.kind,
      expected: preparing.expected,
      priorCurrent: preparing.priorCurrent,
      priorPrevious: preparing.priorPrevious,
      candidate: preparing.candidate,
      preparedTreeSha256: "e".repeat(64),
    });
  });

  it.each([
    "../shared",
    "/etc",
    "1.4.2-aaaa",
    `1.4.2-${"a".repeat(63)}`,
    `shared/1.4.2-${"a".repeat(64)}`,
  ])("rejects non-canonical candidate target %s", async (candidate) => {
    const journal = new DualSlotOperationJournal(directory());

    await expect(journal.start({ ...operation(), candidate })).rejects.toThrow(
      /candidate|release name/i,
    );
  });

  it("selects the prior generation after a torn or checksum-corrupt write", async () => {
    const root = directory();
    const journal = new DualSlotOperationJournal(root);
    const preparing = await journal.start(operation());
    await journal.transition(preparing, "prepared");
    const [left, right] = readSlots(root);
    const newest = left.generation > right.generation ? "a" : "b";

    writeFileSync(slot(root, newest), "torn");
    expect((await journal.load())?.generation).toBe(1);

    const corrupt = {
      ...preparing,
      generation: 2,
      phase: "prepared",
      checksum: "0".repeat(64),
    };
    writeFileSync(slot(root, newest), JSON.stringify(corrupt));
    expect((await journal.load())?.generation).toBe(1);
  });

  it.each([
    ["schemaVersion", 2],
    ["phase", "prepared_v2"],
  ] as const)(
    "ignores a higher slot with unsupported %s",
    async (field, value) => {
      const root = directory();
      const journal = new DualSlotOperationJournal(root);
      const preparing = await journal.start(operation());
      const invalid = checksummed({
        ...preparing,
        generation: 2,
        phase: "prepared",
        [field]: value,
      });
      writeFileSync(slot(root, "a"), JSON.stringify(invalid));

      expect((await journal.load())?.generation).toBe(1);
    },
  );

  it("fails closed when existing slots are both corrupt", async () => {
    const root = directory();
    writeFileSync(slot(root, "a"), "torn");
    writeFileSync(slot(root, "b"), "also torn");

    await expect(new DualSlotOperationJournal(root).load()).rejects.toThrow(
      /journal.*lost|lost.*journal/i,
    );
  });

  it("does not follow a symlink journal slot", async () => {
    const root = directory();
    const outside = resolve(directory(), "outside.json");
    writeFileSync(outside, JSON.stringify(checksummed(operation())));
    symlinkSync(outside, slot(root, "a"));

    await expect(new DualSlotOperationJournal(root).load()).rejects.toThrow(
      /journal.*lost|lost.*journal/i,
    );
  });

  it("rejects stale state and bounded-diagnostic violations before writing", async () => {
    const journal = new DualSlotOperationJournal(directory());
    const preparing = await journal.start(operation());

    await expect(
      journal.transition(
        { ...preparing, checksum: "0".repeat(64) },
        "prepared",
      ),
    ).rejects.toThrow();
    await expect(
      journal.transition(preparing, "prepared", {
        diagnostics: { code: null, notes: Array(17).fill("x") },
      }),
    ).rejects.toThrow(/diagnostics|notes/i);
    await expect(
      journal.transition(preparing, "prepared", {
        diagnostics: { code: null, notes: ["x".repeat(161)] },
      }),
    ).rejects.toThrow(/diagnostics|ASCII/i);
    expect((await journal.load())?.generation).toBe(1);
  });

  it("retains the prior generation when interrupted after syncing the temp file", async () => {
    const root = directory();
    const baseline = new DualSlotOperationJournal(root);
    const preparing = await baseline.start(operation());
    const interrupted = new DualSlotOperationJournal(root, {
      afterTempFileSync: () => {
        throw new Error("simulated process kill");
      },
    });

    await expect(interrupted.transition(preparing, "prepared")).rejects.toThrow(
      /simulated process kill/,
    );
    expect((await baseline.load())?.generation).toBe(1);
  });

  it("refuses a symlink or permissive journal directory", async () => {
    const permissive = directory();
    chmodSync(permissive, 0o755);
    await expect(
      new DualSlotOperationJournal(permissive).start(operation()),
    ).rejects.toThrow(/0700|directory/i);
  });

  it("writes owner-only journal slots", async () => {
    const root = directory();
    await new DualSlotOperationJournal(root).start(operation());

    expect(statSync(slot(root, "a")).mode & 0o777).toBe(0o600);
    expect(statSync(slot(root, "b")).mode & 0o777).toBe(0o600);
  });
});
