import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ClockPort } from '../../events/domain/ports/clock.port';
import type { DatabaseBackupSnapshotPort } from '../../database/application/ports/database-backup-snapshot.port';
import type { ArchiveArtifactRepositoryPort } from './ports/archive-artifact-repository.port';
import type { DriveCredentialRepositoryPort } from './ports/drive-credential-repository.port';
import type { RetireDriveConnectionUseCase } from './use-cases/retire-drive-connection.use-case';
import type { CreateDatabaseBackupUseCase } from './use-cases/create-database-backup.use-case';
import type { DriveAuthorizationPollingService } from './drive-authorization-polling.service';
import {
  ArchiveSchedulerHooksService,
  type ArchiveSchedulerService,
} from './archive-scheduler.service';
import { ArchiveRemoteMutationLockService } from './archive-remote-mutation-lock.service';
import {
  ArchiveWakeService,
  DEFAULT_ARCHIVE_WAKE_SERVICE,
} from './archive-wake.service';

const SHUTDOWN_WAIT_MS = 1_000;
const ARCHIVE_OPERATION_FAILED = 'ARCHIVE_OPERATION_FAILED';

/** Deterministic archive boot recovery and bounded pre-Nest shutdown. */
@Injectable()
export class ArchiveRuntimeLifecycleService
implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ArchiveRuntimeLifecycleService.name);
  private controller = new AbortController();
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private closing = false;

  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort,
      'expireStaged' | 'listInterruptedMaintenance'>,
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'releaseGenerationLeases' | 'clearGenerationSessions' | 'recoverExpiredLeases' | 'listUnverifiedArtifactPaths'>,
    private readonly retire: Pick<RetireDriveConnectionUseCase, 'execute'>,
    private readonly polling: Pick<DriveAuthorizationPollingService, 'cancelAll'>,
    private readonly snapshots: Pick<DatabaseBackupSnapshotPort, 'removeStaleTemporarySnapshots'>,
    private readonly backups: Pick<CreateDatabaseBackupUseCase, 'execute'>,
    private readonly scheduler: Pick<ArchiveSchedulerService, 'startTimers' | 'shutdown'>,
    private readonly hooks: ArchiveSchedulerHooksService,
    private readonly clock: ClockPort,
    private readonly remoteMutationLock: ArchiveRemoteMutationLockService = new ArchiveRemoteMutationLockService(),
    private readonly wake: ArchiveWakeService = DEFAULT_ARCHIVE_WAKE_SERVICE,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.start();
    } catch {
      this.logger.error(`Archive boot recovery failed: ${ARCHIVE_OPERATION_FAILED}`);
    }
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;
    if (this.closing) return Promise.resolve();
    this.startPromise = this.recoverBoot().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.finishShutdown();
    await this.shutdownPromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  private async recoverBoot(): Promise<void> {
    try {
      const signal = this.controller.signal;
      throwIfAborted(signal);
      const nowMs = this.clock.now().getTime();
      await this.credentials.expireStaged(Number.MAX_SAFE_INTEGER);
      throwIfAborted(signal);

      const interrupted = [...await this.credentials.listInterruptedMaintenance()]
        .sort(compareMaintenance);
      throwIfAborted(signal);
      for (const connection of interrupted) {
        await this.repository.releaseGenerationLeases(connection.id, nowMs);
        throwIfAborted(signal);
        await this.repository.clearGenerationSessions(connection.id, nowMs);
        throwIfAborted(signal);
        await this.retire.execute(connection, signal);
        throwIfAborted(signal);
      }

      await this.repository.recoverExpiredLeases(nowMs);
      throwIfAborted(signal);
      await this.runBootJob('Motion reconciliation', () => this.hooks.reconcileMotion(signal));
      throwIfAborted(signal);
      await this.runBootJob('remote maintenance', () =>
        this.hooks.runRemoteMaintenance(this.remoteMutationLock, signal));
      throwIfAborted(signal);
      await this.runBootJob('stale snapshot cleanup', async () => {
        const referencedPaths = new Set(await this.repository.listUnverifiedArtifactPaths());
        await this.snapshots.removeStaleTemporarySnapshots({ nowMs, referencedPaths });
      });
      throwIfAborted(signal);
      await this.runBootJob('database backup', async () => {
        await this.backups.execute({ nowMs });
      });
      throwIfAborted(signal);
      this.scheduler.startTimers();
      this.wake.wake();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      throw error;
    }
  }

  /**
   * Boot-time best-effort work. The scheduler already retries these every tick,
   * so a failure here must stay loud without stopping timers from starting.
   */
  private async runBootJob(name: string, job: () => Promise<void>): Promise<void> {
    try {
      await job();
    } catch {
      if (!this.controller.signal.aborted) {
        this.logger.warn(`${name} failed: ${ARCHIVE_OPERATION_FAILED}`);
      }
    }
  }

  private async finishShutdown(): Promise<void> {
    this.closing = true;
    this.polling.cancelAll();
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException('Archive runtime is shutting down', 'AbortError'));
    }
    const boot = this.startPromise;
    if (boot !== null) await settleBounded(boot, SHUTDOWN_WAIT_MS);
    await this.scheduler.shutdown();
  }
}

function maintenanceOrder(status: string): number {
  return status === 'retiring' ? 0 : status === 'disconnecting' ? 1 : 2;
}

function compareMaintenance(
  left: { status: string; createdAtMs: number; id: string },
  right: { status: string; createdAtMs: number; id: string },
): number {
  return maintenanceOrder(left.status) - maintenanceOrder(right.status)
    || left.createdAtMs - right.createdAtMs
    || left.id.localeCompare(right.id);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

async function settleBounded(operation: Promise<unknown>, waitMs: number): Promise<void> {
  await Promise.race([
    operation.then(() => undefined, () => undefined),
    boundedDelay(waitMs),
  ]);
}

function boundedDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
