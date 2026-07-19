import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CheckedReleaseIdentity,
  OperationJournal,
} from "../../../src/system/domain/ota-contracts";
import { recoverInterruptedActivation } from "../../../installer/ota-recover.mjs";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const CANDIDATE = `1.4.2-${"a".repeat(64)}`;
const PRIOR = `1.4.1-${"b".repeat(64)}`;
const OLDER = `1.4.0-${"c".repeat(64)}`;
const ARTIFACT = "a".repeat(64);
const METADATA = "d".repeat(64);
const TREE = "e".repeat(64);
const EXPECTED = {
  artifact: {
    version: "1.4.2",
    commit: "0".repeat(40),
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://updates.example.test/releases/1.4.2.tar.gz",
    format: "tar.gz",
    size: 1,
    expandedSize: 2,
    maxPreparedSize: 3,
    maxPreparedFiles: 4,
    fileCount: 1,
    sha256: ARTIFACT,
  },
  metadata: {
    metadataVersion: 42,
    channel: "stable",
    payloadSha256: METADATA,
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-31T00:00:00.000Z",
  },
} satisfies CheckedReleaseIdentity;

function journal(
  phase: OperationJournal["phase"] = "activated",
): OperationJournal {
  return {
    schemaVersion: 1,
    generation: 4,
    operationId: OPERATION_ID,
    kind: "update",
    phase,
    expected: EXPECTED,
    acceptedAt: "2030-01-01T00:00:00.000Z",
    requestSha256: "f".repeat(64),
    receiptGeneration: 1,
    priorCurrent: PRIOR,
    priorPrevious: OLDER,
    candidate: CANDIDATE,
    preparedTreeSha256: TREE,
    diagnostics: { code: null, notes: [] },
    updatedAt: "2030-01-01T00:01:00.000Z",
    checksum: "0".repeat(64),
  };
}

function fixture(input: {
  loaded?: OperationJournal | null;
  loadError?: Error;
  candidateKnownGood?: Partial<{
    operationId: string;
    artifactSha256: string;
    metadataSha256: string;
    preparedTreeSha256: string;
  }> | null;
  candidateKnownGoodError?: Error;
  priorKnownGood?: Partial<{
    operationId: string;
    artifactSha256: string;
    metadataSha256: string;
    preparedTreeSha256: string;
  }> | null;
  current?: string | null;
  previous?: string | null;
  rootError?: Error;
}) {
  const events: string[] = [];
  const rootAction = vi.fn(async (operationId: string, action: string) => {
    events.push(`root:${operationId}:${action}`);
    if (input.rootError) throw input.rootError;
  });
  const write = vi.fn(async (report: unknown) => {
    events.push("report");
    return report;
  });
  const stop = vi.fn(async () => events.push("stop"));
  return {
    events,
    rootAction,
    write,
    stop,
    dependencies: {
      journal: {
        load: vi.fn(async () => {
          if (input.loadError) throw input.loadError;
          return input.loaded ?? journal();
        }),
      },
      local: {
        pointers: vi.fn(async () => ({
          current: input.current ?? CANDIDATE,
          previous: input.previous ?? PRIOR,
        })),
        knownGood: vi.fn(async (release: string | null) => {
          if (release === CANDIDATE && input.candidateKnownGoodError) {
            throw input.candidateKnownGoodError;
          }
          const override =
            release === CANDIDATE
              ? input.candidateKnownGood
              : input.priorKnownGood;
          if (override === null) return null;
          return {
            operationId: OPERATION_ID,
            artifactSha256: ARTIFACT,
            metadataSha256: METADATA,
            preparedTreeSha256: TREE,
            ...override,
          };
        }),
      },
      root: { invoke: rootAction, stop },
      reports: { writeDurably: write },
      now: () => new Date("2030-01-01T00:02:00.000Z"),
    },
  };
}

describe("OTA boot recovery", () => {
  it("finalizes post-health activated state without consulting readiness", async () => {
    const setup = fixture({ loaded: journal() });

    await recoverInterruptedActivation(setup.dependencies);

    expect(setup.rootAction).toHaveBeenCalledWith(
      OPERATION_ID,
      "finalize-healthy",
    );
    expect(setup.write).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "updated",
        artifactSha256: ARTIFACT,
        metadataSha256: METADATA,
      }),
    );
  });

  it.each(["activating", "activated"] as const)(
    "restores recorded pointers for interrupted %s state",
    async (phase) => {
      const setup = fixture({
        loaded: journal(phase),
        candidateKnownGood: null,
        previous: phase === "activating" ? OLDER : PRIOR,
      });

      await recoverInterruptedActivation(setup.dependencies);

      expect(setup.rootAction).toHaveBeenCalledWith(
        OPERATION_ID,
        "restore-prior",
      );
      expect(setup.write).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed" }),
      );
      expect(setup.events).toEqual([
        "report",
        `root:${OPERATION_ID}:restore-prior`,
      ]);
    },
  );

  it("stops for an unreadable activated known-good marker", async () => {
    const setup = fixture({
      loaded: journal("activated"),
      candidateKnownGoodError: new Error("corrupt known-good"),
    });

    await recoverInterruptedActivation(setup.dependencies);

    expect(setup.rootAction).not.toHaveBeenCalled();
    expect(setup.events).toEqual(["report", "stop"]);
  });

  it.each([
    [
      "stale known-good operation",
      { candidateKnownGood: { operationId: "BBBBBBBBBBBBBBBBBBBBBA" } },
    ],
    ["conflicting current pointer", { current: PRIOR }],
    ["conflicting previous pointer", { previous: OLDER }],
  ] as const)(
    "stops instead of finalizing or restoring activated state with %s",
    async (_label, conflict) => {
      const setup = fixture({ loaded: journal("activated"), ...conflict });

      await recoverInterruptedActivation(setup.dependencies);

      expect(setup.rootAction).not.toHaveBeenCalled();
      expect(setup.write).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: null,
          outcome: "maintenance-required",
        }),
      );
      expect(setup.events).toEqual(["report", "stop"]);
    },
  );

  it("retains the durable failure report when root restore transitions then crashes", async () => {
    const setup = fixture({
      loaded: journal("activating"),
      candidateKnownGood: null,
      previous: OLDER,
      rootError: new Error("crash after transition"),
    });

    await expect(
      recoverInterruptedActivation(setup.dependencies),
    ).rejects.toThrow("crash after transition");

    expect(setup.events).toEqual([
      "report",
      `root:${OPERATION_ID}:restore-prior`,
    ]);
  });

  it("accepts healthy only with matching pointers and same-operation known-good identity", async () => {
    const setup = fixture({ loaded: journal("healthy") });

    await recoverInterruptedActivation(setup.dependencies);

    expect(setup.write).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "updated" }),
    );
    expect(setup.rootAction).not.toHaveBeenCalled();
    expect(setup.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["current pointer", { current: PRIOR }],
    ["previous pointer", { previous: OLDER }],
    [
      "known-good operation",
      { candidateKnownGood: { operationId: "BBBBBBBBBBBBBBBBBBBBBA" } },
    ],
    [
      "known-good tree",
      { candidateKnownGood: { preparedTreeSha256: "9".repeat(64) } },
    ],
    [
      "known-good artifact identity",
      { candidateKnownGood: { artifactSha256: "8".repeat(64) } },
    ],
    [
      "known-good metadata identity",
      { candidateKnownGood: { metadataSha256: "7".repeat(64) } },
    ],
  ] as const)(
    "fails closed for healthy with conflicting %s",
    async (_label, conflict) => {
      const setup = fixture({ loaded: journal("healthy"), ...conflict });

      await recoverInterruptedActivation(setup.dependencies);

      expect(setup.write).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: null,
          outcome: "maintenance-required",
        }),
      );
      expect(setup.events).toEqual(["report", "stop"]);
    },
  );

  it("revalidates an already rolled-back operation idempotently before allowing boot", async () => {
    const setup = fixture({
      loaded: journal("rolled_back"),
      current: PRIOR,
      previous: OLDER,
    });

    await recoverInterruptedActivation(setup.dependencies);

    expect(setup.events).toEqual([
      "report",
      `root:${OPERATION_ID}:restore-prior`,
    ]);
    expect(setup.write).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it.each([
    "preparing",
    "prepared",
    "failed_pre_activation",
    "rollback_failed",
    "cleanup_pending",
  ] as const)(
    "fails closed instead of falling through legal %s state",
    async (phase) => {
      const setup = fixture({ loaded: journal(phase) });

      await recoverInterruptedActivation(setup.dependencies);

      expect(setup.rootAction).not.toHaveBeenCalled();
      expect(setup.write).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: null,
          outcome: "maintenance-required",
        }),
      );
      expect(setup.events).toEqual(["report", "stop"]);
    },
  );

  it("persists null-identity maintenance before stopping on corrupt slots", async () => {
    const setup = fixture({ loadError: new Error("operation journal lost") });

    await recoverInterruptedActivation(setup.dependencies);

    expect(setup.write).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: null,
        kind: null,
        outcome: "maintenance-required",
        artifactSha256: null,
        metadataSha256: null,
      }),
    );
    expect(setup.events).toEqual(["report", "stop"]);
  });

  it("installs the isolated pre-PM2 recovery launcher and fixed helper actions", () => {
    const unit = readFileSync(
      resolve("systemd/home-worker-ota-recover.service"),
      "utf8",
    );
    const sudoers = readFileSync(
      resolve("systemd/home-worker-ota-recovery.sudoers"),
      "utf8",
    );
    const installer = readFileSync(resolve("scripts/install.sh"), "utf8");
    const launcher = readFileSync(resolve("installer/ota-recover.mjs"), "utf8");

    expect(unit).toContain("Before=pm2-homeworker.service");
    expect(unit).toContain("User=homeworker");
    expect(unit).toContain("PrivateNetwork=yes");
    expect(unit).toContain("ReadWritePaths=/opt/home-worker");
    expect(unit).toContain("RequiredBy=pm2-homeworker.service");
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /usr/lib/home-worker/ota-recover.mjs",
    );
    expect(sudoers).toContain("--recover-finalize *");
    expect(sudoers).toContain("--recover-restore *");
    expect(installer).toContain(
      "/usr/lib/home-worker/ota-contracts.mjs install-policy",
    );
    expect(installer).toContain(
      "systemctl enable home-worker-ota-recover.service",
    );
    expect(launcher).not.toMatch(
      /fetch\(|better-sqlite3|migrate|extract|waitForHealth/,
    );
  });
});
