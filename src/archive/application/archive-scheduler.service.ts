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
import {
  ArchiveWakeService,
  DEFAULT_ARCHIVE_WAKE_SERVICE,
} from './archive-wake.service';
import type {
  ArchiveProviderAdmission,
  ArchiveProviderGateService,
} from './archive-provider-gate.service';
import type { DriveCredentialRepositoryPort } from './ports/drive-credential-repository.port';

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
  private activePump: Promise<void> | null = null;
  private activeUpload: Promise<void> | null = null;
  private consecutiveFreshVideos = 0;

  constructor(
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'claimNextAttempt' | 'listUnattemptedArtifacts' | 'readSchedulerState' |
      'compareAndSetSchedulerState' | 'markRetryable' | 'readNextDeadline'>,
    private readonly backups: Pick<CreateDatabaseBackupUseCase, 'execute'>,
    private readonly uploads: Pick<UploadDriveObjectAttemptUseCase, 'execute' | 'executeClaimed'>,
    private readonly hooks: ArchiveSchedulerHooksService,
    private readonly remoteMutationLock: ArchiveRemoteMutationLockService,
    private readonly retention: ArchiveRetentionPort,
    private readonly clock: ClockPort,
    options: ArchiveSchedulerOptions = {},
    private readonly wake: ArchiveWakeService = DEFAULT_ARCHIVE_WAKE_SERVICE,
    private readonly providerGate?: Pick<ArchiveProviderGateService, 'inspect' | 'recordQuotaOutcome'>,
    private readonly credentials?: Pick<DriveCredentialRepositoryPort, 'loadActive'>,
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
    this.ensurePump();
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
    this.wake.wake();
  }

  async tick(): Promise<void> {
    if (!this.acceptingWork || this.activeTick !== null) return;
    const running = this.runTick();
    this.activeTick = running;
    try {
      await running;
    } finally {
      if (this.activeTick === running) this.activeTick = null;
      this.wake.wake();
      this.ensurePump();
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
  }

  async shutdown(): Promise<void> {
    this.stopTimers();
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException('Archive runtime is shutting down', 'AbortError'));
    }
    const active = [this.activeTick, this.activeUpload, this.activePump].filter(
      (operation): operation is Promise<void> => operation !== null,
    );
    if (active.length === 0) return;
    await Promise.race([
      Promise.allSettled(active).then(() => undefined),
      boundedDelay(this.shutdownWaitMs),
    ]);
  }

  private ensurePump(): void {
    if (!this.acceptingWork || this.activePump !== null) return;
    const running = this.runPump();
    this.activePump = running;
    void running.catch((error: unknown) => {
      if (!this.controller.signal.aborted) {
        this.logger.error(`Archive scheduler pump failed: ${message(error)}`);
      }
    }).finally(() => {
      if (this.activePump === running) this.activePump = null;
    });
  }

  private async runPump(): Promise<void> {
    const signal = this.controller.signal;
    while (this.acceptingWork && !signal.aborted) {
      const context = await this.loadProviderContext();
      if (context.generationId !== null && canDispatch(context.admission)) {
        const worked = await this.dispatchOneTransfer(
          this.clock.now().getTime(),
          signal,
          context.generationId,
        );
        if (worked) {
          await yieldToEventLoop();
          continue;
        }
      }

      const expectedEpoch = this.wake.snapshot();
      const finalContext = await this.loadProviderContext();
      if (finalContext.generationId !== null && canDispatch(finalContext.admission)) {
        const worked = await this.dispatchOneTransfer(
          this.clock.now().getTime(),
          signal,
          finalContext.generationId,
        );
        if (worked) {
          await yieldToEventLoop();
          continue;
        }
      }
      if (signal.aborted || !this.acceptingWork) return;
      const nowMs = this.clock.now().getTime();
      const deadlineMs = finalContext.generationId === null
        ? null
        : await this.repository.readNextDeadline(
          finalContext.generationId,
          nowMs,
          finalContext.admission.kind === 'cooldown'
            ? finalContext.admission.untilMs
            : null,
        );
      await this.wake.waitForChange(
        expectedEpoch,
        deadlineMs,
        this.intervalMs,
        signal,
      );
      if (deadlineMs !== null && this.wake.snapshot() === expectedEpoch) {
        this.wake.wake();
      }
    }
  }

  private async loadProviderContext(): Promise<{
    generationId: string | null;
    admission: ArchiveProviderAdmission;
  }> {
    const active = await this.credentials?.loadActive();
    if (active === null || active === undefined) {
      return { generationId: null, admission: { kind: 'allowed' } };
    }
    const admission = this.providerGate === undefined
      ? { kind: 'allowed' as const }
      : await this.providerGate.inspect(active.id, 'upload');
    return { generationId: active.id, admission };
  }

  private async dispatchOneTransfer(
    nowMs: number,
    signal: AbortSignal,
    generationId: string,
  ): Promise<boolean> {
    if (this.activeUpload !== null) return false;
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
      await this.dispatchClaimed(backupClaim, signal, nowMs, generationId);
      return true;
    }
    if (signal.aborted) return false;
    const [newBackup] = await this.repository.listUnattemptedArtifacts({
      kind: 'database_backup', limit: 1,
    });
    if (signal.aborted) return false;
    if (newBackup !== undefined) {
      this.consecutiveFreshVideos = 0;
      await this.runTransfer(
        this.uploads.execute(newBackup.id, signal),
        signal,
        newBackup.size,
        generationId,
      );
      return true;
    }
    if (forceVideoRetryBeforeMs !== undefined) {
      const retry = await this.repository.claimNextAttempt({
        ...baseClaim,
        kind: 'motion_video',
        retryOnly: true,
        forceVideoRetryBeforeMs,
      });
      if (retry !== null) {
        await this.dispatchClaimed(retry, signal, nowMs, generationId);
        return true;
      }
      if (signal.aborted) return false;
    }
    const [newVideo] = await this.repository.listUnattemptedArtifacts({
      kind: 'motion_video', limit: 1,
    });
    if (signal.aborted) return false;
    if (newVideo !== undefined) {
      this.consecutiveFreshVideos += 1;
      await this.runTransfer(
        this.uploads.execute(newVideo.id, signal),
        signal,
        newVideo.size,
        generationId,
      );
      return true;
    }
    const claimed = await this.repository.claimNextAttempt({
      ...baseClaim,
      kind: 'motion_video',
    });
    if (claimed !== null) {
      await this.dispatchClaimed(claimed, signal, nowMs, generationId);
      return true;
    }
    return false;
  }

  private async dispatchClaimed(
    claimed: ClaimedAttempt,
    signal: AbortSignal,
    nowMs: number,
    generationId: string,
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
    await this.runTransfer(
      this.uploads.executeClaimed(claimed, signal),
      signal,
      claimed.artifact.size,
      generationId,
    );
  }

  private async runTransfer(
    transferOperation: Promise<unknown>,
    signal: AbortSignal,
    pendingArtifactBytes: number,
    generationId: string,
  ): Promise<void> {
    const transfer = transferOperation
      .then(async () => { await this.recordSchedulerSuccess({ lastUploadSuccessMs: this.clock.now().getTime() }); })
      .catch(async (error: unknown) => {
        if (signal.aborted) return;
        if (error instanceof DriveQuotaExceededError) {
          const requiredBytes = boundedPendingBytes(pendingArtifactBytes);
          let remainingDeficitBytes = requiredBytes;
          if (requiredBytes > 0) {
            try {
              const result = await this.retention.execute({ requiredBytes }, signal);
              remainingDeficitBytes = result.remainingDeficitBytes;
            } catch (retentionError) {
              this.logger.warn(`Archive quota reclamation failed: ${message(retentionError)}`);
            }
          }
          await this.providerGate?.recordQuotaOutcome(generationId, remainingDeficitBytes);
        }
        this.logger.warn(`Archive upload failed: ${message(error)}`);
      });
    const tracked = transfer.finally(() => {
      if (this.activeUpload === tracked) this.activeUpload = null;
      this.wake.wake();
    });
    this.activeUpload = tracked;
    await tracked;
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

function canDispatch(admission: ArchiveProviderAdmission): boolean {
  return admission.kind === 'allowed' || admission.kind === 'probe';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function boundedDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
