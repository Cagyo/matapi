import { describe, expect, it, vi } from "vitest";
import type {
  OperationJournal,
  ReadinessMarker,
} from "../../../src/system/domain/ota-contracts";
import {
  OtaActivationCoordinator,
  OtaActivationError,
  type OtaActivationDependencies,
} from "../../../src/system/infrastructure/pm2-release.gateway";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const ARTIFACT_SHA = "a".repeat(64);
const METADATA_SHA = "b".repeat(64);
const TREE_SHA = "c".repeat(64);
const PRIOR_CURRENT = `1.4.1-${"d".repeat(64)}`;
const PRIOR_PREVIOUS = `1.4.0-${"e".repeat(64)}`;
const CANDIDATE = `1.4.2-${ARTIFACT_SHA}`;

function journal(
  phase: OperationJournal["phase"] = "prepared",
): OperationJournal {
  return {
    schemaVersion: 1,
    generation: 2,
    operationId: OPERATION_ID,
    kind: "update",
    phase,
    expected: {
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
        url: "https://updates.example.test/1.4.2.tar.gz",
        format: "tar.gz",
        size: 1,
        expandedSize: 2,
        maxPreparedSize: 3,
        maxPreparedFiles: 4,
        fileCount: 1,
        sha256: ARTIFACT_SHA,
      },
      metadata: {
        metadataVersion: 42,
        channel: "stable",
        payloadSha256: METADATA_SHA,
        publishedAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-02-01T00:00:00.000Z",
      },
    },
    acceptedAt: "2030-01-15T00:00:00.000Z",
    requestSha256: "f".repeat(64),
    receiptGeneration: 1,
    priorCurrent: PRIOR_CURRENT,
    priorPrevious: PRIOR_PREVIOUS,
    candidate: CANDIDATE,
    preparedTreeSha256: TREE_SHA,
    diagnostics: { code: null, notes: [] },
    updatedAt: "2030-01-15T00:00:00.000Z",
    checksum: "0".repeat(64),
  };
}

function ready(pid = 100): ReadinessMarker {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    pid,
    artifactSha256: ARTIFACT_SHA,
    metadataSha256: METADATA_SHA,
    writtenAt: "2030-01-15T00:00:01.000Z",
  };
}

function fixture(events: string[], marker: ReadinessMarker | null = ready()) {
  let current = journal();
  const dependencies: OtaActivationDependencies = {
    prepared: {
      revalidate: vi.fn(async () => {
        events.push("prepared:revalidate");
        return {
          releasePath: `/opt/home-worker/releases/${CANDIDATE}`,
          artifactSha256: ARTIFACT_SHA,
          metadataSha256: METADATA_SHA,
          preparedTreeSha256: TREE_SHA,
        };
      }),
    },
    journal: {
      load: vi.fn(async () => current),
      transition: vi.fn(async (source, phase) => {
        events.push(`journal:${phase}`);
        current = { ...source, generation: source.generation + 1, phase };
        return current;
      }),
    },
    links: {
      setCurrent: vi.fn(async (target) => events.push(`current:${target}`)),
      setPrevious: vi.fn(async (target) => events.push(`previous:${target}`)),
      restore: vi.fn(async (snapshots) => {
        events.push(`restore:${snapshots.current}:${snapshots.previous}`);
      }),
    },
    process: {
      stop: vi.fn(async () => events.push("pm2:stop")),
      migrate: vi.fn(async () => events.push("migrate")),
      start: vi.fn(async () => events.push("pm2:start")),
      inspect: vi.fn(async () => ({
        pid: 100,
        restartCount: 0,
        uptimeMs: 61_000,
        status: "online" as const,
      })),
    },
    readiness: {
      clear: vi.fn(async () => events.push("ready:clear")),
      read: vi.fn(async () => marker),
    },
    health: {
      waitStable: vi.fn(async (input) => {
        events.push("health:stable");
        const observed = await dependencies.process.inspect();
        const found = await dependencies.readiness.read();
        if (
          found === null ||
          found.operationId !== input.operationId ||
          found.artifactSha256 !== input.artifactSha256 ||
          found.metadataSha256 !== input.metadataSha256 ||
          found.pid !== input.first.pid ||
          observed.pid !== input.first.pid ||
          observed.restartCount !== input.first.restartCount ||
          observed.uptimeMs < input.stableMs
        ) {
          throw new OtaActivationError("readiness");
        }
      }),
    },
    knownGood: {
      writeDurably: vi.fn(async () => events.push("known-good:fsync")),
    },
    metadata: {
      mirror: vi.fn(async () => events.push("system-meta:mirror")),
    },
    now: () => new Date("2030-01-15T00:02:00.000Z"),
    stableMs: 60_000,
  };
  return dependencies;
}

describe("OtaActivationCoordinator", () => {
  it("uses the exact migration, journal, switch, and operation-bound health ordering", async () => {
    const events: string[] = [];
    const activation = new OtaActivationCoordinator(fixture(events));

    await activation.run(OPERATION_ID);

    expect(events.indexOf("prepared:revalidate")).toBeLessThan(
      events.indexOf("pm2:stop"),
    );
    expect(events.indexOf("migrate")).toBeLessThan(
      events.indexOf("journal:activating"),
    );
    expect(events.indexOf("journal:activating")).toBeLessThan(
      events.indexOf(`current:${CANDIDATE}`),
    );
    expect(events.indexOf(`current:${CANDIDATE}`)).toBeLessThan(
      events.indexOf("journal:activated"),
    );
    expect(events.indexOf("journal:activated")).toBeLessThan(
      events.indexOf("health:stable"),
    );
    expect(events.indexOf("known-good:fsync")).toBeLessThan(
      events.indexOf("journal:healthy"),
    );
    expect(events.indexOf(`previous:${PRIOR_CURRENT}`)).toBeLessThan(
      events.indexOf("journal:healthy"),
    );
  });

  it.each([
    ["wrong-operation", { ...ready(), operationId: "BBBBBBBBBBBBBBBBBBBBBB" }],
    ["wrong-artifact", { ...ready(), artifactSha256: "9".repeat(64) }],
    ["pid-replaced", ready(101)],
  ])("restores both journal snapshots on %s", async (_case, marker) => {
    const events: string[] = [];
    const activation = new OtaActivationCoordinator(fixture(events, marker));

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "readiness",
    });
    expect(events).toContain(`restore:${PRIOR_CURRENT}:${PRIOR_PREVIOUS}`);
    expect(events.indexOf("pm2:start")).toBeLessThan(
      events.indexOf("journal:rolled_back"),
    );
  });

  it.each(["restart-counter-increased", "early-exit"])(
    "restores both journal snapshots on %s",
    async (failure) => {
      const events: string[] = [];
      const dependencies = fixture(events);
      dependencies.health.waitStable = vi.fn(async () => {
        throw new OtaActivationError(
          failure === "early-exit" ? "pm2" : "restart-loop",
        );
      });
      const activation = new OtaActivationCoordinator(dependencies);

      await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
        code: failure === "early-exit" ? "pm2" : "restart-loop",
      });
      expect(events).toContain(`restore:${PRIOR_CURRENT}:${PRIOR_PREVIOUS}`);
      expect(events.indexOf("pm2:start")).toBeLessThan(
        events.indexOf("journal:rolled_back"),
      );
    },
  );

  it("rejects a changed durable prepared journal before PM2 is stopped", async () => {
    const events: string[] = [];
    const dependencies = fixture(events);
    dependencies.journal.load = vi.fn(async () => ({
      ...journal(),
      candidate: `1.4.3-${"9".repeat(64)}`,
    }));
    const activation = new OtaActivationCoordinator(dependencies);

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "maintenance-required",
    });
    expect(events).not.toContain("pm2:stop");
  });

  it("restores both snapshots when current rename completed before its durability error", async () => {
    const events: string[] = [];
    const dependencies = fixture(events);
    dependencies.links.setCurrent = vi.fn(async () => {
      events.push("current:renamed-before-fsync-error");
      throw new OtaActivationError("activation");
    });
    const activation = new OtaActivationCoordinator(dependencies);

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "activation",
    });
    expect(events).toContain(`restore:${PRIOR_CURRENT}:${PRIOR_PREVIOUS}`);
    expect(events.indexOf("pm2:start")).toBeLessThan(
      events.indexOf("journal:rolled_back"),
    );
  });

  it("durably records rollback_failed when the restored release cannot restart", async () => {
    const events: string[] = [];
    const dependencies = fixture(events, { ...ready(), pid: 101 });
    dependencies.process.start = vi.fn(async (context) => {
      if (context === undefined) {
        events.push("pm2:restore-failed");
        throw new Error("injected restored process failure");
      }
      events.push("pm2:start");
    });
    const activation = new OtaActivationCoordinator(dependencies);

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "rollback",
    });
    expect(events).toContain("journal:rollback_failed");
  });

  it("restores both pointers when previous cannot be committed before healthy", async () => {
    const events: string[] = [];
    const dependencies = fixture(events);
    dependencies.links.setPrevious = vi.fn(async () => {
      events.push("previous:failed");
      throw new OtaActivationError("activation");
    });
    const activation = new OtaActivationCoordinator(dependencies);

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "activation",
    });
    expect(events).not.toContain("journal:healthy");
    expect(events).toContain(`restore:${PRIOR_CURRENT}:${PRIOR_PREVIOUS}`);
    expect(events).toContain("journal:rolled_back");
  });

  it("preserves committed pointers and activated journal when healthy persistence fails", async () => {
    const events: string[] = [];
    const dependencies = fixture(events);
    dependencies.journal.transition = vi.fn(
      async (
        source: OperationJournal,
        phase: OperationJournal["phase"],
      ): Promise<OperationJournal> => {
        events.push(`journal:${phase}`);
        if (phase === "healthy")
          throw new Error("injected journal fsync failure");
        return { ...source, generation: source.generation + 1, phase };
      },
    );
    const activation = new OtaActivationCoordinator(dependencies);

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "maintenance-required",
    });
    expect(events.indexOf(`previous:${PRIOR_CURRENT}`)).toBeLessThan(
      events.indexOf("journal:healthy"),
    );
    expect(events).not.toContain(`restore:${PRIOR_CURRENT}:${PRIOR_PREVIOUS}`);
    expect(events).not.toContain("journal:rolled_back");
  });

  it("rejects a nonzero initial PM2 restart counter", async () => {
    const events: string[] = [];
    const dependencies = fixture(events);
    dependencies.process.inspect = vi.fn(async () => ({
      pid: 100,
      restartCount: 1,
      uptimeMs: 1,
      status: "online" as const,
    }));
    const activation = new OtaActivationCoordinator(dependencies);

    await expect(activation.run(OPERATION_ID)).rejects.toMatchObject({
      code: "pm2",
    });
    expect(events).toContain(`restore:${PRIOR_CURRENT}:${PRIOR_PREVIOUS}`);
  });

  it("makes a local rollback reversible by swapping the two recorded targets", async () => {
    const events: string[] = [];
    const dependencies = fixture(events);
    const rollbackJournal = {
      ...journal(),
      kind: "rollback" as const,
      expected: null,
      candidate: PRIOR_PREVIOUS,
    };
    dependencies.journal.load = vi.fn(async () => rollbackJournal);
    dependencies.prepared.revalidate = vi.fn(async () => ({
      releasePath: `/opt/home-worker/releases/${PRIOR_PREVIOUS}`,
      artifactSha256: "e".repeat(64),
      metadataSha256: "8".repeat(64),
      preparedTreeSha256: TREE_SHA,
    }));
    dependencies.readiness.read = vi.fn(async () => ({
      ...ready(),
      artifactSha256: "e".repeat(64),
      metadataSha256: "8".repeat(64),
    }));
    const activation = new OtaActivationCoordinator(dependencies);

    await activation.run(OPERATION_ID);

    expect(events.indexOf(`current:${PRIOR_PREVIOUS}`)).toBeGreaterThan(-1);
    expect(events.indexOf(`previous:${PRIOR_CURRENT}`)).toBeLessThan(
      events.indexOf("journal:healthy"),
    );
  });
});
