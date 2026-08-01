import {
  Injectable,
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

/** Deterministic archive boot recovery and bounded pre-Nest shutdown. */
@Injectable()
export class ArchiveRuntimeLifecycleService
implements OnApplicationBootstrap, OnModuleDestroy {
  private controller = new AbortController();
  private startPromise: Promise<void> | null = null;
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
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
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
    if (this.closing) return;
    this.closing = true;
    this.polling.cancelAll();
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException('Archive runtime is shutting down', 'AbortError'));
    }
    await this.scheduler.shutdown();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  private async recoverBoot(): Promise<void> {
    const nowMs = this.clock.now().getTime();
    await this.credentials.expireStaged(Number.MAX_SAFE_INTEGER);

    const interrupted = [...await this.credentials.listInterruptedMaintenance()]
      .sort((left, right) => maintenanceOrder(left.status) - maintenanceOrder(right.status));
    for (const connection of interrupted) {
      await this.repository.releaseGenerationLeases(connection.id, nowMs);
      await this.repository.clearGenerationSessions(connection.id, nowMs);
      await this.retire.execute(connection, this.controller.signal);
    }

    await this.repository.recoverExpiredLeases(nowMs);
    await this.hooks.reconcileMotion(this.controller.signal);
    await this.hooks.runRemoteMaintenance(this.remoteMutationLock, this.controller.signal);
    const referencedPaths = new Set(await this.repository.listUnverifiedArtifactPaths());
    await this.snapshots.removeStaleTemporarySnapshots({ nowMs, referencedPaths });
    await this.backups.execute({ nowMs });
    if (!this.controller.signal.aborted) this.scheduler.startTimers();
  }
}

function maintenanceOrder(status: string): number {
  return status === 'retiring' ? 0 : status === 'disconnecting' ? 1 : 2;
}
