import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { ClockPort } from '../../events/domain/ports/clock.port';
import type {
  ArchiveArtifactRepositoryPort,
  ArchiveSchedulerUpdate,
  ClaimedAttempt,
} from './ports/archive-artifact-repository.port';
import type { CreateDatabaseBackupUseCase } from './use-cases/create-database-backup.use-case';
import type { UploadDriveObjectAttemptUseCase } from './use-cases/upload-drive-object-attempt.use-case';
import { ArchiveRemoteMutationLockService } from './archive-remote-mutation-lock.service';

const DEFAULT_INTERVAL_MS = 2 * 60 * 1_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_NEWER_VIDEO_BATCH = 3;
const DEFAULT_SHUTDOWN_WAIT_MS = 1_000;

export interface ArchiveCameraSchedulerHooks {
  reconcileMotion(signal: AbortSignal): Promise<void>;
  cleanupLocal(signal: AbortSignal): Promise<void>;
}

export type ArchiveRemoteMaintenanceHook = (
  lock: ArchiveRemoteMutationLockService,
  signal: AbortSignal,
) => Promise<void>;

/** Runtime registration seam that avoids Archive importing Camera or Task 12. */
@Injectable()
export class ArchiveSchedulerHooksService {
  private camera: ArchiveCameraSchedulerHooks | null = null;
  private remoteMaintenance: ArchiveRemoteMaintenanceHook | null = null;

  registerCamera(hooks: ArchiveCameraSchedulerHooks): void {
    this.camera = hooks;
  }

  registerRemoteMaintenance(hook: ArchiveRemoteMaintenanceHook): void {
    this.remoteMaintenance = hook;
  }

  async reconcileMotion(signal: AbortSignal): Promise<void> {
    await this.camera?.reconcileMotion(signal);
  }

  async cleanupLocal(signal: AbortSignal): Promise<void> {
    await this.camera?.cleanupLocal(signal);
  }

  async runRemoteMaintenance(
    lock: ArchiveRemoteMutationLockService,
    signal: AbortSignal,
  ): Promise<void> {
    await this.remoteMaintenance?.(lock, signal);
  }
}

export interface ArchiveSchedulerOptions {
  intervalMs?: number;
  leaseMs?: number;
  newerVideoBatch?: number;
  shutdownWaitMs?: number;
  owner?: () => string;
}

/**
 * Bounded archive dispatcher. Database selection completes before upload I/O;
 * the transfer runs independently so a stalled network cannot block backup,
 * Motion reconciliation, local cleanup, or a later non-overlapping tick.
 */
@Injectable()
export class ArchiveSchedulerService {
  private readonly logger = new Logger(ArchiveSchedulerService.name);
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly newerVideoBatch: number;
  private readonly shutdownWaitMs: number;
  private readonly owner: () => string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller = new AbortController();
  private tickRunning = false;
  private acceptingWork = true;
  private activeUpload: Promise<void> | null = null;
  private consecutiveFreshVideos = 0;

  constructor(
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'claimNextAttempt' | 'listUnattemptedArtifacts' | 'readSchedulerState' | 'compareAndSetSchedulerState'>,
    private readonly backups: Pick<CreateDatabaseBackupUseCase, 'execute'>,
    private readonly uploads: Pick<UploadDriveObjectAttemptUseCase, 'execute' | 'executeClaimed'>,
    private readonly hooks: ArchiveSchedulerHooksService,
    private readonly remoteMutationLock: ArchiveRemoteMutationLockService,
    private readonly clock: ClockPort,
    options: ArchiveSchedulerOptions = {},
  ) {
    this.intervalMs = positive(options.intervalMs ?? DEFAULT_INTERVAL_MS, 'interval');
    this.leaseMs = positive(options.leaseMs ?? DEFAULT_LEASE_MS, 'lease');
    this.newerVideoBatch = positive(options.newerVideoBatch ?? DEFAULT_NEWER_VIDEO_BATCH, 'fairness batch');
    this.shutdownWaitMs = positive(options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS, 'shutdown wait');
    this.owner = options.owner ?? randomUUID;
  }

  startTimers(): void {
    if (this.timer !== null) return;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.acceptingWork = true;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stopTimers(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.acceptingWork = false;
  }

  async tick(): Promise<void> {
    if (!this.acceptingWork || this.tickRunning) return;
    this.tickRunning = true;
    const nowMs = this.clock.now().getTime();
    const signal = this.controller.signal;
    try {
      await Promise.all([
        this.runJob('database backup', async () => {
          await this.backups.execute({ nowMs, scheduled: true });
        }),
        this.runJob('Motion reconciliation', async () => {
          await this.hooks.reconcileMotion(signal);
          await this.recordSchedulerSuccess({ lastReconcileSuccessMs: nowMs });
        }),
        this.runJob('local cleanup', async () => {
          await this.hooks.cleanupLocal(signal);
          await this.recordSchedulerSuccess({ lastCleanupSuccessMs: nowMs });
        }),
        this.runJob('remote maintenance', () =>
          this.hooks.runRemoteMaintenance(this.remoteMutationLock, signal)),
      ]);
      if (!signal.aborted) await this.dispatchOneTransfer(nowMs, signal);
    } finally {
      this.tickRunning = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopTimers();
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException('Archive runtime is shutting down', 'AbortError'));
    }
    const active = this.activeUpload;
    if (active === null) return;
    await Promise.race([active, boundedDelay(this.shutdownWaitMs)]);
  }

  private async dispatchOneTransfer(nowMs: number, signal: AbortSignal): Promise<void> {
    if (this.activeUpload !== null) return;
    const forceVideoRetryBeforeMs = this.consecutiveFreshVideos >= this.newerVideoBatch
      ? nowMs
      : undefined;
    const baseClaim = {
      owner: this.owner(),
      nowMs,
      leaseMs: this.leaseMs,
      preferBackups: true,
    };
    const backupClaim = await this.repository.claimNextAttempt({
      ...baseClaim,
      kind: 'database_backup',
    });
    if (backupClaim !== null) {
      this.dispatchClaimed(backupClaim, signal);
      return;
    }
    const [newBackup] = await this.repository.listUnattemptedArtifacts({
      kind: 'database_backup', limit: 1,
    });
    if (newBackup !== undefined) {
      this.consecutiveFreshVideos = 0;
      this.trackTransfer(this.uploads.execute(newBackup.id, signal), signal);
      return;
    }
    if (forceVideoRetryBeforeMs !== undefined) {
      const retry = await this.repository.claimNextAttempt({
        ...baseClaim,
        kind: 'motion_video',
        retryOnly: true,
        forceVideoRetryBeforeMs,
      });
      if (retry !== null) {
        this.dispatchClaimed(retry, signal);
        return;
      }
    }
    const [newVideo] = await this.repository.listUnattemptedArtifacts({
      kind: 'motion_video', limit: 1,
    });
    if (newVideo !== undefined) {
      this.consecutiveFreshVideos += 1;
      this.trackTransfer(this.uploads.execute(newVideo.id, signal), signal);
      return;
    }
    const claimed = await this.repository.claimNextAttempt({
      ...baseClaim,
      kind: 'motion_video',
    });
    if (claimed !== null) this.dispatchClaimed(claimed, signal);
  }

  private dispatchClaimed(claimed: ClaimedAttempt, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.noteAdmission(claimed);
    this.trackTransfer(this.uploads.executeClaimed(claimed, signal), signal);
  }

  private trackTransfer(transferOperation: Promise<unknown>, signal: AbortSignal): void {
    const transfer = transferOperation
      .then(async () => { await this.recordSchedulerSuccess({ lastUploadSuccessMs: this.clock.now().getTime() }); })
      .catch((error: unknown) => {
        if (!signal.aborted) this.logger.warn(`Archive upload failed: ${message(error)}`);
      });
    const tracked = transfer.finally(() => {
      if (this.activeUpload === tracked) this.activeUpload = null;
    });
    this.activeUpload = tracked;
  }

  private noteAdmission(claimed: ClaimedAttempt): void {
    if (claimed.artifact.kind === 'database_backup' || claimed.attempt.retryCount > 0) {
      this.consecutiveFreshVideos = 0;
      return;
    }
    this.consecutiveFreshVideos += 1;
  }

  private async recordSchedulerSuccess(update: ArchiveSchedulerUpdate): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.repository.readSchedulerState();
      if (await this.repository.compareAndSetSchedulerState(state.revision, update)) return;
    }
  }

  private async runJob(name: string, job: () => Promise<void>): Promise<void> {
    try {
      await job();
    } catch (error) {
      if (!this.controller.signal.aborted) this.logger.warn(`${name} failed: ${message(error)}`);
    }
  }
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Archive scheduler ${label} is invalid`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
