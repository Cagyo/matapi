import type {
  KnownGoodMarker,
  OperationJournal,
  ReadinessMarker,
} from "../domain/ota-contracts";
import { parseOtaOperationId } from "../domain/ota-contracts";
import { artifactDirectoryName } from "../domain/release-identity";
import type { OperationJournalTransitionUpdate } from "./dual-slot-operation-journal";

export class OtaActivationError extends Error {
  constructor(
    readonly code:
      | "activation"
      | "migration"
      | "pm2"
      | "readiness"
      | "restart-loop"
      | "rollback"
      | "maintenance-required",
  ) {
    super(code);
    this.name = "OtaActivationError";
  }
}

export interface PreparedActivation {
  releasePath: string;
  artifactSha256: string;
  metadataSha256: string;
  preparedTreeSha256: string;
}

export interface Pm2ReleaseSnapshot {
  pid: number;
  restartCount: number;
  uptimeMs: number;
  status: "online" | "stopped" | "errored" | "launching";
}

export interface OtaActivationDependencies {
  prepared: {
    revalidate(journal: OperationJournal): Promise<PreparedActivation>;
  };
  journal: {
    load(): Promise<OperationJournal | null>;
    transition(
      current: OperationJournal,
      phase: OperationJournal["phase"],
      update?: OperationJournalTransitionUpdate,
    ): Promise<OperationJournal>;
  };
  links: {
    setCurrent(target: string): Promise<void>;
    setPrevious(target: string | null): Promise<void>;
    restore(snapshots: {
      current: string | null;
      previous: string | null;
    }): Promise<void>;
  };
  process: {
    stop(): Promise<void>;
    migrate(releasePath: string): Promise<void>;
    start(context?: {
      operationId: string;
      artifactSha256: string;
      metadataSha256: string;
    }): Promise<void>;
    inspect(): Promise<Pm2ReleaseSnapshot>;
  };
  readiness: {
    clear(): Promise<void>;
    read(): Promise<ReadinessMarker | null>;
  };
  health: {
    waitStable(input: {
      operationId: string;
      artifactSha256: string;
      metadataSha256: string;
      first: Pm2ReleaseSnapshot;
      stableMs: number;
    }): Promise<void>;
  };
  knownGood: {
    writeDurably(path: string, marker: KnownGoodMarker): Promise<void>;
  };
  metadata: {
    mirror(input: {
      artifactSha256: string;
      metadataSha256: string;
    }): Promise<void>;
  };
  now(): Date;
  stableMs: number;
}

function fail(code: OtaActivationError["code"]): never {
  throw new OtaActivationError(code);
}

function assertPrepared(
  operationId: string,
  journal: OperationJournal | null,
): asserts journal is OperationJournal & {
  candidate: string;
  preparedTreeSha256: string;
} {
  if (
    journal?.operationId !== operationId ||
    journal.phase !== "prepared" ||
    journal.candidate === null ||
    journal.preparedTreeSha256 === null ||
    (journal.kind === "update" && journal.expected === null)
  ) {
    fail("maintenance-required");
  }
}

function exactPrepared(
  journal: OperationJournal,
  prepared: PreparedActivation,
): boolean {
  const expected = journal.expected;
  return (
    journal.candidate !== null &&
    journal.preparedTreeSha256 !== null &&
    prepared.preparedTreeSha256 === journal.preparedTreeSha256 &&
    prepared.releasePath.endsWith(`/${journal.candidate}`) &&
    journal.candidate.endsWith(`-${prepared.artifactSha256}`) &&
    (journal.kind === "rollback" ||
      (expected !== null &&
        artifactDirectoryName(expected.artifact) === journal.candidate &&
        prepared.artifactSha256 === expected.artifact.sha256 &&
        prepared.metadataSha256 === expected.metadata.payloadSha256))
  );
}

export class OtaActivationCoordinator {
  constructor(private readonly dependencies: OtaActivationDependencies) {}

  async run(operationIdInput: string): Promise<void> {
    const operationId = parseOtaOperationId(operationIdInput);
    let journal = await this.dependencies.journal.load();
    assertPrepared(operationId, journal);
    const prepared = await this.dependencies.prepared.revalidate(journal);
    if (!exactPrepared(journal, prepared)) fail("maintenance-required");
    const candidateName = journal.candidate;

    const snapshots = {
      current: journal.priorCurrent,
      previous: journal.priorPrevious,
    };
    let stopped = false;
    let switched = false;
    let previousCommitted = false;
    try {
      await this.dependencies.readiness.clear();
      stopped = true;
      await this.dependencies.process.stop();
      await this.dependencies.process.migrate(prepared.releasePath);
      journal = await this.dependencies.journal.transition(
        journal,
        "activating",
      );
      switched = true;
      await this.dependencies.links.setCurrent(candidateName);
      journal = await this.dependencies.journal.transition(
        journal,
        "activated",
      );
      await this.dependencies.process.start({
        operationId,
        artifactSha256: prepared.artifactSha256,
        metadataSha256: prepared.metadataSha256,
      });
      const first = await this.dependencies.process.inspect();
      if (
        first.status !== "online" ||
        !Number.isSafeInteger(first.pid) ||
        first.pid <= 0 ||
        !Number.isSafeInteger(first.restartCount) ||
        first.restartCount !== 0
      ) {
        fail("pm2");
      }
      await this.dependencies.health.waitStable({
        operationId,
        artifactSha256: prepared.artifactSha256,
        metadataSha256: prepared.metadataSha256,
        first,
        stableMs: this.dependencies.stableMs,
      });
      const marker: KnownGoodMarker = {
        schemaVersion: 1,
        operationId,
        artifactSha256: prepared.artifactSha256,
        metadataSha256: prepared.metadataSha256,
        preparedTreeSha256: prepared.preparedTreeSha256,
        activatedAt: this.dependencies.now().toISOString(),
      };
      await this.dependencies.knownGood.writeDurably(
        prepared.releasePath,
        marker,
      );
      await this.dependencies.links.setPrevious(snapshots.current);
      previousCommitted = true;
      journal = await this.dependencies.journal.transition(journal, "healthy", {
        updatedAt: marker.activatedAt,
      });
      await this.dependencies.metadata.mirror({
        artifactSha256: prepared.artifactSha256,
        metadataSha256: prepared.metadataSha256,
      });
    } catch (error) {
      if (previousCommitted) fail("maintenance-required");
      if (switched) {
        try {
          await this.dependencies.links.restore(snapshots);
          await this.dependencies.process.start();
        } catch {
          await this.dependencies.journal
            .transition(journal, "rollback_failed", {
              diagnostics: { code: "rollback", notes: [] },
              updatedAt: this.dependencies.now().toISOString(),
            })
            .catch(() => undefined);
          fail("rollback");
        }
        await this.dependencies.journal.transition(journal, "rolled_back", {
          diagnostics: {
            code:
              error instanceof OtaActivationError ? error.code : "activation",
            notes: [],
          },
          updatedAt: this.dependencies.now().toISOString(),
        });
      } else if (stopped) {
        try {
          await this.dependencies.process.start();
        } catch {
          fail("rollback");
        }
      }
      throw error;
    }
  }
}
