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
import type { ArchiveRetentionPort } from './ports/archive-retention.port';
import { DriveQuotaExceededError } from '../domain/errors/drive-quota-exceeded.error';

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
  private acceptingWork = true;
  private activeTick: Promise<void> | null = null;
  private activeUpload: Promise<void> | null = null;
  private consecutiveFreshVideos = 0;

  constructor(
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'claimNextAttempt' | 'listUnattemptedArtifacts' | 'readSchedulerState' |
      'compareAndSetSchedulerState' | 'markRetryable'>,
    private readonly backups: Pick<CreateDatabaseBackupUseCase, 'execute'>,
    private readonly uploads: Pick<UploadDriveObjectAttemptUseCase, 'execute' | 'executeClaimed'>,
    private readonly hooks: ArchiveSchedulerHooksService,
    private readonly remoteMutationLock: ArchiveRemoteMutationLockService,
    private readonly retention: ArchiveRetentionPort,
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
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(`Archive scheduler tick failed: ${message(error)}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stopTimers(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.acceptingWork = false;
  }

  async tick(): Promise<void> {
    if (!this.acceptingWork || this.activeTick !== null) return;
    const running = this.runTick();
    this.activeTick = running;
    try {
      await running;
    } finally {
      if (this.activeTick === running) this.activeTick = null;
    }
  }

  private async runTick(): Promise<void> {
    const nowMs = this.clock.now().getTime();
    const signal = this.controller.signal;
    await Promise.all([
      this.runJob('database backup', async () => {
        await this.backups.execute({ nowMs, scheduled: true });
      }),
      this.runJob('Motion reconciliation', async () => {
        await this.hooks.reconcileMotion(signal);
        if (!signal.aborted) {
          await this.recordSchedulerSuccess({ lastReconcileSuccessMs: nowMs });
        }
      }),
      this.runJob('local cleanup', async () => {
        await this.hooks.cleanupLocal(signal);
        if (!signal.aborted) {
          await this.recordSchedulerSuccess({ lastCleanupSuccessMs: nowMs });
        }
      }),
      this.runJob('remote maintenance', () =>
        this.hooks.runRemoteMaintenance(this.remoteMutationLock, signal)),
    ]);
    if (!signal.aborted) await this.dispatchOneTransfer(nowMs, signal);
  }

  async shutdown(): Promise<void> {
    this.stopTimers();
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException('Archive runtime is shutting down', 'AbortError'));
    }
    const active = [this.activeTick, this.activeUpload].filter(
      (operation): operation is Promise<void> => operation !== null,
    );
    if (active.length === 0) return;
    await Promise.race([
      Promise.allSettled(active).then(() => undefined),
      boundedDelay(this.shutdownWaitMs),
    ]);
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
      await this.dispatchClaimed(backupClaim, signal, nowMs);
      return;
    }
    if (signal.aborted) return;
    const [newBackup] = await this.repository.listUnattemptedArtifacts({
      kind: 'database_backup', limit: 1,
    });
    if (signal.aborted) return;
    if (newBackup !== undefined) {
      this.consecutiveFreshVideos = 0;
      this.trackTransfer(this.uploads.execute(newBackup.id, signal), signal, newBackup.size);
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
        await this.dispatchClaimed(retry, signal, nowMs);
        return;
      }
      if (signal.aborted) return;
    }
    const [newVideo] = await this.repository.listUnattemptedArtifacts({
      kind: 'motion_video', limit: 1,
    });
    if (signal.aborted) return;
    if (newVideo !== undefined) {
      this.consecutiveFreshVideos += 1;
      this.trackTransfer(this.uploads.execute(newVideo.id, signal), signal, newVideo.size);
      return;
    }
    const claimed = await this.repository.claimNextAttempt({
      ...baseClaim,
      kind: 'motion_video',
    });
    if (claimed !== null) await this.dispatchClaimed(claimed, signal, nowMs);
  }

  private async dispatchClaimed(
    claimed: ClaimedAttempt,
    signal: AbortSignal,
    nowMs: number,
  ): Promise<void> {
    if (signal.aborted) {
      try {
        await this.repository.markRetryable(
          claimed.attempt.id,
          claimed.lease,
          'cancelled',
          nowMs,
          nowMs,
        );
      } catch (error) {
        this.logger.warn(`Failed to release cancelled archive claim: ${message(error)}`);
      }
      return;
    }
    this.noteAdmission(claimed);
    this.trackTransfer(
      this.uploads.executeClaimed(claimed, signal),
      signal,
      claimed.artifact.size,
    );
  }

  private trackTransfer(
    transferOperation: Promise<unknown>,
    signal: AbortSignal,
    pendingArtifactBytes: number,
  ): void {
    const transfer = transferOperation
      .then(async () => { await this.recordSchedulerSuccess({ lastUploadSuccessMs: this.clock.now().getTime() }); })
      .catch(async (error: unknown) => {
        if (signal.aborted) return;
        if (error instanceof DriveQuotaExceededError) {
          const requiredBytes = boundedPendingBytes(pendingArtifactBytes);
          if (requiredBytes > 0) {
            try {
              await this.retention.execute({ requiredBytes }, signal);
            } catch (retentionError) {
              this.logger.warn(`Archive quota reclamation failed: ${message(retentionError)}`);
            }
          }
        }
        this.logger.warn(`Archive upload failed: ${message(error)}`);
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

function boundedPendingBytes(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
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
