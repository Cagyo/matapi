import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { ClockPort } from '../../events/domain/ports/clock.port';
import type {
  ArchiveArtifactRepositoryPort,
  ArchiveClockHealth,
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
import type { ArchiveAdminAlertKind, ArchiveAdminAlertPort } from './ports/archive-admin-alert.port';
import type {
  ArchiveProviderState,
  ArchiveProviderStateRepositoryPort,
} from './ports/archive-provider-state-repository.port';
import type { LocalStoragePort } from '../../camera/domain/ports/local-storage.port';
import type { ArchiveSchedulerActivitySnapshot } from './use-cases/report-drive-status.use-case';
import type { ArchiveRuntimeSignalPort } from './ports/archive-runtime-signal.port';
import { ArchiveClockHealthService } from './archive-clock-health.service';
import type { DriveConnection } from '../domain/drive-connection.entity';
import type { ProbeDriveQuotaRecoveryUseCase } from './use-cases/probe-drive-quota-recovery.use-case';
import type { RevalidateMotionArchiveBranchUseCase } from './use-cases/revalidate-motion-archive-branch.use-case';

const DEFAULT_INTERVAL_MS = 2 * 60 * 1_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_NEWER_VIDEO_BATCH = 3;
const DEFAULT_SHUTDOWN_WAIT_MS = 1_000;
const PROLONGED_PROVIDER_COOLDOWN_MS = 15 * 60 * 1_000;
const PROLONGED_BACKLOG_AGE_MS = 24 * 60 * 60 * 1_000;
const LOCAL_DISK_PRESSURE_PERCENT = 70;
const ARCHIVE_OPERATION_FAILED = 'ARCHIVE_OPERATION_FAILED';

type AdmissionResult = 'none' | 'admitted' | 'reload';

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
export class ArchiveSchedulerService implements ArchiveRuntimeSignalPort {
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
  private activity: ArchiveSchedulerActivitySnapshot | null = null;
  private consecutiveFreshVideos = 0;

  constructor(
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'claimNextAttempt' | 'listUnattemptedArtifacts' | 'readSchedulerState' |
      'compareAndSetSchedulerState' | 'markRetryable' | 'readNextDeadline' | 'readQueueStatus'>,
    private readonly backups: Pick<CreateDatabaseBackupUseCase, 'execute'>,
    private readonly uploads: Pick<UploadDriveObjectAttemptUseCase, 'execute' | 'executeClaimed'>,
    private readonly hooks: ArchiveSchedulerHooksService,
    private readonly remoteMutationLock: ArchiveRemoteMutationLockService,
    private readonly retention: ArchiveRetentionPort,
    private readonly clock: ClockPort,
    options: ArchiveSchedulerOptions = {},
    private readonly wake: ArchiveWakeService = DEFAULT_ARCHIVE_WAKE_SERVICE,
    private readonly providerGate?: Pick<ArchiveProviderGateService,
      'ensureGeneration' | 'inspect' | 'recordQuotaOutcome' | 'run'>,
    private readonly credentials?: Pick<DriveCredentialRepositoryPort, 'loadActive'>,
    private readonly providerState?: Pick<ArchiveProviderStateRepositoryPort, 'load'>,
    private readonly alerts?: ArchiveAdminAlertPort,
    private readonly localDisk?: Pick<LocalStoragePort, 'usagePercent'>,
    private readonly clockHealth: Pick<ArchiveClockHealthService, 'check'> =
      new ArchiveClockHealthService(repository, wake),
    private readonly branchProbe?: Pick<RevalidateMotionArchiveBranchUseCase, 'executeNext'>,
    private readonly quotaProbe?: Pick<ProbeDriveQuotaRecoveryUseCase, 'execute'>,
  ) {
    this.intervalMs = positive(options.intervalMs ?? DEFAULT_INTERVAL_MS, 'interval');
    this.leaseMs = positive(options.leaseMs ?? DEFAULT_LEASE_MS, 'lease');
    this.newerVideoBatch = positive(options.newerVideoBatch ?? DEFAULT_NEWER_VIDEO_BATCH, 'fairness batch');
    this.shutdownWaitMs = positive(options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS, 'shutdown wait');
    this.owner = options.owner ?? randomUUID;
  }

  readActivitySnapshot(): ArchiveSchedulerActivitySnapshot | null {
    return this.activity === null ? null : { ...this.activity };
  }

  async motionTraversalCompleted(completedAtMs: number): Promise<void> {
    if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0) {
      throw new Error('Motion traversal completion time is invalid');
    }
    for (;;) {
      const state = await this.repository.readSchedulerState();
      if (state.lastMotionTraversalSuccessMs !== null
        && state.lastMotionTraversalSuccessMs >= completedAtMs) {
        this.wake.wake();
        return;
      }
      if (await this.repository.compareAndSetSchedulerState(state.revision, {
        lastMotionTraversalSuccessMs: completedAtMs,
      })) {
        this.wake.wake();
        return;
      }
    }
  }

  startTimers(): void {
    if (this.timer !== null) return;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.acceptingWork = true;
    this.ensurePump();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.logger.error(`Archive scheduler tick failed: ${ARCHIVE_OPERATION_FAILED}`);
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
    const clockHealth = await this.clockHealth.check(nowMs);
    if (clockHealth === 'clock-blocked') {
      await this.runClockBlockedContinuity(nowMs, signal);
      return;
    }
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
    await this.runJob('archive health alerts', () => this.evaluateOperationalAlerts(nowMs));
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
    void running.catch(() => {
      if (!this.controller.signal.aborted) {
        this.logger.error(`Archive scheduler pump failed: ${ARCHIVE_OPERATION_FAILED}`);
      }
    }).finally(() => {
      if (this.activePump === running) this.activePump = null;
    });
  }

  private async runPump(): Promise<void> {
    const signal = this.controller.signal;
    let skipAdmissionAfterProbeReload = false;
    while (this.acceptingWork && !signal.aborted) {
      const expectedEpoch = this.wake.snapshot();
      try {
        const nowMs = this.clock.now().getTime();
        const clockHealth = await this.clockHealth.check(nowMs);
        if (clockHealth === 'clock-blocked') {
          await this.runClockBlockedContinuity(nowMs, signal);
          if (signal.aborted || !this.acceptingWork) return;
          const continuityEpoch = this.wake.snapshot();
          await this.wake.waitForChange(
            continuityEpoch,
            null,
            this.intervalMs,
            signal,
            nowMs,
          );
          continue;
        }
        const context = await this.loadProviderContext();
        if (skipAdmissionAfterProbeReload) {
          skipAdmissionAfterProbeReload = false;
        } else {
          const admission = await this.admitOne(
            { ...context, clockHealth }, nowMs, signal, expectedEpoch,
          );
          if (admission === 'admitted') {
            await yieldToEventLoop();
            continue;
          }
          if (admission === 'reload') {
            skipAdmissionAfterProbeReload = true;
            continue;
          }
        }
        if (signal.aborted || !this.acceptingWork) return;
        const deadlineMs = context.generation === null
          ? null
          : await this.repository.readNextDeadline(
            {
              generationId: context.generation.id,
              nowMs,
              providerDeadlineMs: context.providerDeadlineMs,
            },
          );
        const futureDeadlineMs = deadlineMs !== null && deadlineMs > nowMs
          ? deadlineMs
          : null;
        await this.wake.waitForChange(
          expectedEpoch,
          futureDeadlineMs,
          this.intervalMs,
          signal,
          nowMs,
        );
      } catch {
        if (signal.aborted || !this.acceptingWork) return;
        this.logger.error(`Archive scheduler pump failed: ${ARCHIVE_OPERATION_FAILED}`);
        await this.wake.waitForChange(
          expectedEpoch,
          null,
          this.intervalMs,
          signal,
        );
      }
    }
  }

  private async loadProviderContext(): Promise<{
    generation: DriveConnection | null;
    admission: ArchiveProviderAdmission;
    providerDeadlineMs: number | null;
  }> {
    return this.remoteMutationLock.runExclusive(async () => {
      const active = await this.credentials?.loadActive();
      if (active === null || active === undefined) {
        return {
          generation: null,
          admission: { kind: 'blocked', reason: 'stale_generation' },
          providerDeadlineMs: null,
        };
      }
      if (this.providerGate === undefined) {
        return {
          generation: active,
          admission: active.status === 'active'
            ? { kind: 'allowed' }
            : { kind: 'blocked', reason: 'reauthorization_required' },
          providerDeadlineMs: null,
        };
      }
      const provider = await this.providerGate.ensureGeneration(active.id);
      if (active.status !== 'active') {
        return {
          generation: active,
          admission: { kind: 'blocked', reason: 'reauthorization_required' },
          providerDeadlineMs: provider.generationId === active.id
            ? provider.cooldownUntilMs
            : null,
        };
      }
      const admission = await this.providerGate.inspect(active.id, 'upload');
      return {
        generation: active,
        admission,
        providerDeadlineMs: admission.kind === 'cooldown'
          ? admission.untilMs
          : provider.generationId === active.id
            ? provider.cooldownUntilMs
            : null,
      };
    });
  }

  private async admitOne(
    context: {
      generation: DriveConnection | null;
      admission: ArchiveProviderAdmission;
      providerDeadlineMs: number | null;
      clockHealth: ArchiveClockHealth;
    },
    nowMs: number,
    signal: AbortSignal,
    expectedEpoch: number,
  ): Promise<AdmissionResult> {
    if (context.clockHealth === 'clock-blocked' || context.generation === null) return 'none';
    if (context.admission.kind === 'probe') {
      if (context.admission.operationClass === 'folder') {
        const branchProbe = this.branchProbe;
        const generation = context.generation;
        if (branchProbe === undefined || this.providerGate === undefined || generation === null) {
          return 'none';
        }
        try {
          await this.providerGate.run({
            generationId: generation.id,
            operationClass: 'folder',
            probe: true,
            operation: () => branchProbe.executeNext(generation, nowMs, signal),
            signal,
          });
          await this.settleProbe();
          return 'admitted';
        } catch (error) {
          return this.settleFailedProbe(error, signal);
        }
      }
      if (context.admission.reason === 'quota') {
        if (this.quotaProbe === undefined) return 'none';
        try {
          const result = await this.quotaProbe.execute(
            context.generation,
            context.admission,
            signal,
          );
          if (result === 'stale') {
            await this.settleProbe();
            return 'reload';
          }
          await this.settleProbe();
          return 'admitted';
        } catch (error) {
          return this.settleFailedProbe(error, signal);
        }
      }
      if (context.admission.operationClass !== 'upload') return 'none';
      return (await this.dispatchOneTransfer(nowMs, signal, context.generation.id))
        ? 'admitted'
        : 'none';
    }
    if (context.admission.kind !== 'allowed') return 'none';
    if (this.branchProbe !== undefined) {
      const branchProbe = this.branchProbe;
      const generation = context.generation;
      let result: Awaited<ReturnType<RevalidateMotionArchiveBranchUseCase['executeNext']>>;
      try {
        result = this.providerGate === undefined
          ? await branchProbe.executeNext(generation, nowMs, signal)
          : await this.providerGate.run({
              generationId: generation.id,
              operationClass: 'folder',
              probe: true,
              operation: () => branchProbe.executeNext(generation, nowMs, signal),
              signal,
            });
      } catch (error) {
        return this.settleFailedProbe(error, signal);
      }
      if (result !== 'none') {
        await this.settleProbe();
        return 'admitted';
      }
      // A transfer or concurrent mutation can settle while the no-op probe is
      // in flight. Its wake invalidates this provider/generation snapshot, so
      // reload it before admitting another transfer.
      if (this.wake.snapshot() !== expectedEpoch) return 'admitted';
    }
    return (await this.dispatchOneTransfer(nowMs, signal, context.generation.id))
      ? 'admitted'
      : 'none';
  }

  private async settleProbe(): Promise<void> {
    await yieldToEventLoop();
    this.wake.wake();
  }

  private async settleFailedProbe(
    error: unknown,
    signal: AbortSignal,
  ): Promise<AdmissionResult> {
    if (signal.aborted) throw error;
    this.logger.error(`Archive scheduler pump failed: ${ARCHIVE_OPERATION_FAILED}`);
    await this.settleProbe();
    return 'reload';
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
      generationId,
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
      return true;
    }
    if (signal.aborted) return false;
    const [newBackup] = await this.repository.listUnattemptedArtifacts({
      kind: 'database_backup', generationId, nowMs, limit: 1,
    });
    if (signal.aborted) return false;
    if (newBackup !== undefined) {
      this.consecutiveFreshVideos = 0;
      let selectedGenerationId: string | null = null;
      this.startTransfer(
        this.uploads.execute(
          newBackup.id,
          signal,
          (selected) => { selectedGenerationId = selected; },
        ),
        signal,
        newBackup.size,
        () => selectedGenerationId,
        { generationId, artifactKind: 'database_backup', startedAtMs: nowMs },
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
        await this.dispatchClaimed(retry, signal, nowMs);
        return true;
      }
      if (signal.aborted) return false;
    }
    const [newVideo] = await this.repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId, nowMs, limit: 1,
    });
    if (signal.aborted) return false;
    if (newVideo !== undefined) {
      this.consecutiveFreshVideos += 1;
      let selectedGenerationId: string | null = null;
      this.startTransfer(
        this.uploads.execute(
          newVideo.id,
          signal,
          (selected) => { selectedGenerationId = selected; },
        ),
        signal,
        newVideo.size,
        () => selectedGenerationId,
        { generationId, artifactKind: 'motion_video', startedAtMs: nowMs },
      );
      return true;
    }
    const claimed = await this.repository.claimNextAttempt({
      ...baseClaim,
      kind: 'motion_video',
    });
    if (claimed !== null) {
      await this.dispatchClaimed(claimed, signal, nowMs);
      return true;
    }
    return false;
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
      } catch {
        this.logger.warn(`Failed to release cancelled archive claim: ${ARCHIVE_OPERATION_FAILED}`);
      }
      return;
    }
    this.noteAdmission(claimed);
    let selectedGenerationId: string | null = null;
    this.startTransfer(
      this.uploads.executeClaimed(
        claimed,
        signal,
        (selected) => { selectedGenerationId = selected; },
      ),
      signal,
      claimed.artifact.size,
      () => selectedGenerationId,
      {
        generationId: claimed.attempt.generationId,
        artifactKind: claimed.artifact.kind,
        startedAtMs: nowMs,
      },
    );
  }

  private startTransfer(
    transferOperation: Promise<unknown>,
    signal: AbortSignal,
    pendingArtifactBytes: number,
    selectedGenerationId: () => string | null,
    activity: ArchiveSchedulerActivitySnapshot,
  ): void {
    void this.runTransfer(
      transferOperation,
      signal,
      pendingArtifactBytes,
      selectedGenerationId,
      activity,
    ).catch(() => {
      if (!signal.aborted) {
        this.logger.error(`Archive scheduler transfer settlement failed: ${ARCHIVE_OPERATION_FAILED}`);
      }
    });
  }

  private async runTransfer(
    transferOperation: Promise<unknown>,
    signal: AbortSignal,
    pendingArtifactBytes: number,
    selectedGenerationId: () => string | null,
    activity: ArchiveSchedulerActivitySnapshot,
  ): Promise<void> {
    this.activity = activity;
    const transfer = transferOperation
      .then(async (result) => {
        if (isVerifiedTransferResult(result)) {
          await this.recordSchedulerSuccess({ lastUploadSuccessMs: this.clock.now().getTime() });
        }
      })
      .catch(async (error: unknown) => {
        if (signal.aborted) return;
        if (error instanceof DriveQuotaExceededError) {
          const requiredBytes = boundedPendingBytes(pendingArtifactBytes);
          let remainingDeficitBytes = requiredBytes;
          const clockHealth = await this.clockHealth.check(this.clock.now().getTime());
          if (requiredBytes > 0 && clockHealth === 'healthy') {
            try {
              const result = await this.retention.execute({ requiredBytes }, signal);
              remainingDeficitBytes = result.remainingDeficitBytes;
            } catch {
              this.logger.warn(`Archive quota reclamation failed: ${ARCHIVE_OPERATION_FAILED}`);
            }
          }
          const generationId = selectedGenerationId();
          if (generationId !== null) {
            await this.providerGate?.recordQuotaOutcome(generationId, remainingDeficitBytes);
          }
        }
        this.logger.warn(`Archive upload failed: ${ARCHIVE_OPERATION_FAILED}`);
      });
    const tracked = transfer.finally(async () => {
      await yieldToEventLoop();
      if (this.activeUpload === tracked) this.activeUpload = null;
      if (this.activity === activity) this.activity = null;
      this.wake.wake();
    });
    this.activeUpload = tracked;
    await tracked;
  }

  private async evaluateOperationalAlerts(nowMs: number): Promise<void> {
    if (this.credentials === undefined || this.providerState === undefined || this.alerts === undefined) return;
    const active = await this.credentials.loadActive();
    if (active === null) return;
    const [provider, queue, localDiskUsagePercent] = await Promise.all([
      this.providerState.load(),
      this.repository.readQueueStatus(active.id, nowMs),
      this.localDisk?.usagePercent().catch(() => null) ?? Promise.resolve(null),
    ]);
    const confirmed = await this.credentials.loadActive();
    if (confirmed?.id !== active.id
      || confirmed.revision !== active.revision
      || confirmed.status !== active.status) return;
    const kinds = deriveArchiveOperationalAlertKinds({
      nowMs,
      generationId: active.id,
      reauthorizationRequired: active.status === 'reauth_required',
      provider,
      oldestQueuedVideoAtMs: queue.oldestQueuedVideoAtMs,
      queuedVideos: queue.queuedVideos,
      localDiskUsagePercent,
    });
    for (const kind of kinds) {
      await this.alerts.alert(kind, { generationId: active.id }).catch(() => undefined);
    }
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

  private async runClockBlockedContinuity(
    nowMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.runJob('database backup', async () => {
      await this.backups.execute({ nowMs, scheduled: true });
    });
    if (signal.aborted) return;
    await this.runJob('Motion reconciliation', () => this.hooks.reconcileMotion(signal));
  }

  private async runJob(name: string, job: () => Promise<void>): Promise<void> {
    try {
      await job();
    } catch {
      if (!this.controller.signal.aborted) this.logger.warn(`${name} failed: ${ARCHIVE_OPERATION_FAILED}`);
    }
  }
}

export function deriveArchiveOperationalAlertKinds(input: {
  nowMs: number;
  generationId: string;
  reauthorizationRequired: boolean;
  provider: ArchiveProviderState;
  queuedVideos: number;
  oldestQueuedVideoAtMs: number | null;
  localDiskUsagePercent: number | null;
}): readonly ArchiveAdminAlertKind[] {
  const kinds = new Set<ArchiveAdminAlertKind>();
  const providerMatches = input.provider.generationId === input.generationId;
  if (input.reauthorizationRequired
    || (providerMatches && input.provider.blockReason === 'reauthorization_required')) {
    kinds.add('reauthorization-required');
  }
  if (providerMatches && input.provider.blockReason === 'account_creation_limit') {
    kinds.add('provider-capacity-blocked');
  }
  if (providerMatches && input.provider.blockReason === 'quota_exhausted') {
    kinds.add('quota-reclamation-required');
  }
  if (providerMatches
    && input.provider.cooldownUntilMs !== null
    && input.provider.cooldownUntilMs > input.nowMs
    && input.nowMs - input.provider.updatedAtMs >= PROLONGED_PROVIDER_COOLDOWN_MS) {
    kinds.add('provider-cooldown-prolonged');
  }
  if (input.queuedVideos > 0
    && input.oldestQueuedVideoAtMs !== null
    && input.nowMs - input.oldestQueuedVideoAtMs >= PROLONGED_BACKLOG_AGE_MS) {
    kinds.add('backlog-age-prolonged');
  }
  if (input.localDiskUsagePercent !== null
    && Number.isFinite(input.localDiskUsagePercent)
    && input.localDiskUsagePercent >= LOCAL_DISK_PRESSURE_PERCENT) {
    kinds.add('local-disk-pressure');
  }
  return [...kinds];
}

function boundedPendingBytes(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Archive scheduler ${label} is invalid`);
  return value;
}

function isVerifiedTransferResult(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && 'kind' in result
    && result.kind === 'verified';
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
