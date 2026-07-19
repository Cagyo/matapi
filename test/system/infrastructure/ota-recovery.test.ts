import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OperationJournal } from "../../../src/system/domain/ota-contracts";
import { recoverInterruptedActivation } from "../../../installer/ota-recover.mjs";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const CANDIDATE = `1.4.2-${"a".repeat(64)}`;
const PRIOR = `1.4.1-${"b".repeat(64)}`;
const OLDER = `1.4.0-${"c".repeat(64)}`;
const ARTIFACT = "a".repeat(64);
const METADATA = "d".repeat(64);
const TREE = "e".repeat(64);

function journal(
  phase: OperationJournal["phase"] = "activated",
): OperationJournal {
  return {
    schemaVersion: 1,
    generation: 4,
    operationId: OPERATION_ID,
    kind: "update",
    phase,
    expected: null,
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
  knownGood?: boolean;
  current?: string | null;
  previous?: string | null;
}) {
  const events: string[] = [];
  const rootAction = vi.fn(async (operationId: string, action: string) => {
    events.push(`root:${operationId}:${action}`);
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
        knownGood: vi.fn(async (release: string | null) =>
          input.knownGood === false && release === CANDIDATE
            ? null
            : {
                operationId: OPERATION_ID,
                artifactSha256: ARTIFACT,
                metadataSha256: METADATA,
                preparedTreeSha256: TREE,
              },
        ),
      },
      root: { invoke: rootAction, stop },
      reports: { writeDurably: write },
      now: () => new Date("2030-01-01T00:02:00.000Z"),
    },
  };
}

describe("OTA boot recovery", () => {
  it("finalizes post-health activated state without consulting readiness", async () => {
    const setup = fixture({ loaded: journal(), knownGood: true });

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

  it("restores recorded pointers for other activated state", async () => {
    const setup = fixture({ loaded: journal(), knownGood: false });

    await recoverInterruptedActivation(setup.dependencies);

    expect(setup.rootAction).toHaveBeenCalledWith(
      OPERATION_ID,
      "restore-prior",
    );
    expect(setup.write).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

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
