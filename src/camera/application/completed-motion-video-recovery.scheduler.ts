import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { ArchiveRuntimeSignalPort } from '../../archive/application/ports/archive-runtime-signal.port';
import { CAMERA_MODE, type CameraMode } from '../camera.tokens';
import { CompletedMotionVideoFilesystemError } from '../domain/errors/completed-motion-video-filesystem.error';
import { ADMIN_ALERT, type AdminAlertPort } from '../domain/ports/admin-alert.port';
import {
  COMPLETED_MOTION_VIDEO,
  type CompletedMotionVideoPort,
  type CompletedMotionVideoTraversal,
} from '../domain/ports/completed-motion-video.port';
import {
  RegisterCompletedMotionVideosUseCase,
  type CompletedMotionRecoveryOptions,
} from './register-completed-motion-videos.use-case';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Marker for a failure that carries no Camera-owned code. Only
 * `CompletedMotionVideoFilesystemError.code` is provably path-free — it is a
 * three-value union built in one place — so everything else degrades to this.
 */
const CAMERA_OPERATION_FAILED = 'CAMERA_OPERATION_FAILED';

/**
 * Consecutive failed traversals before admins are alerted. At the two-minute
 * safety tick a persistently unreadable scan root reaches this within roughly
 * four minutes, while a one-off transient filesystem error is ridden out.
 *
 * The load-bearing constraint is not transient tolerance: this must exceed the
 * number of traversals that can fail before `AdminAlertService` has a delegate,
 * because an alert raised earlier is dropped by a service that still resolves.
 * Nest boots modules by descending distance, so Archive's boot job fails once
 * and Camera's boot wake fails once before Telegram registers the delegate —
 * two today, leaving a margin of one. Adding another boot-phase `reconcile()`
 * caller, or a retry inside `runBootJob`, means raising this too.
 * `SCAN_ALERT_REPEAT_MS` is the backstop if that margin is ever lost.
 */
const SCAN_FAILURE_ALERT_THRESHOLD = 3;

/**
 * How long the raised alert suppresses repeats. A dropped or undelivered first
 * alert retries on the next failure past this window instead of leaving the
 * outage silent forever; a genuinely stuck scan costs at most four DMs a day.
 */
const SCAN_ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

export type CompletedMotionRecoveryWakeReason = 'boot' | 'motion-event' | 'safety';

interface RecoveryClock {
  now(): number;
}

const NOOP_PROGRESS: ArchiveRuntimeSignalPort = {
  motionTraversalCompleted: async () => undefined,
};

const SYSTEM_CLOCK: RecoveryClock = { now: Date.now };

const NOOP_ADMIN_ALERT: AdminAlertPort = {
  alert: async () => undefined,
};

/** Cooperatively drains one explicit filesystem traversal without overlapping it. */
@Injectable()
export class CompletedMotionVideoRecoveryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompletedMotionVideoRecoveryScheduler.name);
  private inFlight: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private readonly abortListenerCleanups = new Set<() => void>();
  private pendingMotionWake = false;
  private lastSafetyTraversalStartedMs: number | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failures while opening, draining, or closing a traversal. */
  private consecutiveFailures = 0;
  private scanAlertAtMs: number | null = null;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    @Inject(RegisterCompletedMotionVideosUseCase)
    private readonly registration: Pick<RegisterCompletedMotionVideosUseCase, 'reconcileBatch'>,
    @Inject(COMPLETED_MOTION_VIDEO)
    private readonly completedVideos: Pick<CompletedMotionVideoPort, 'openTraversal'>,
    private readonly options: CompletedMotionRecoveryOptions,
    @Optional() private readonly progress: ArchiveRuntimeSignalPort = NOOP_PROGRESS,
    @Optional() private readonly clock: RecoveryClock = SYSTEM_CLOCK,
    @Optional()
    @Inject(ADMIN_ALERT)
    private readonly alerts: AdminAlertPort = NOOP_ADMIN_ALERT,
  ) {}

  onApplicationBootstrap(): void {
    this.wake('boot');
  }

  @Interval('completed-motion-video-recovery', RECOVERY_INTERVAL_MS)
  reconcileTick(): void {
    this.wake('safety');
  }

  wake(reason: CompletedMotionRecoveryWakeReason): void {
    if (this.mode !== 'real') return;
    if (this.inFlight !== null) {
      if (reason === 'motion-event') this.pendingMotionWake = true;
      return;
    }
    if (reason === 'safety') {
      this.dispatchSafetyBestEffort();
      return;
    }
    this.dispatchBestEffort(reason);
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    if (this.mode !== 'real') return Promise.resolve();
    if (this.inFlight !== null) {
      this.bridgeAbort(signal, this.activeController);
      return this.inFlight;
    }

    return this.startTraversal('boot', signal);
  }

  private startTraversal(
    reason: CompletedMotionRecoveryWakeReason,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.inFlight !== null) {
      this.bridgeAbort(signal, this.activeController);
      return this.inFlight;
    }

    this.cancelSafetyTimer();
    if (reason === 'safety') this.lastSafetyTraversalStartedMs = this.clock.now();
    const controller = new AbortController();
    this.activeController = controller;
    this.bridgeAbort(signal, controller);
    const shared = this.openAndRunTraversal(controller.signal).finally(() => {
      if (this.inFlight !== shared) return;
      this.inFlight = null;
      this.cleanupAbortListeners();
      if (this.activeController === controller) this.activeController = null;
      if (this.pendingMotionWake) {
        this.pendingMotionWake = false;
        this.dispatchBestEffort('motion-event');
      }
    });
    this.inFlight = shared;
    return shared;
  }

  private dispatchSafetyBestEffort(): void {
    const earliestStart = this.lastSafetyTraversalStartedMs === null
      ? this.clock.now()
      : this.lastSafetyTraversalStartedMs + RECOVERY_INTERVAL_MS;
    const delayMs = earliestStart - this.clock.now();
    if (delayMs <= 0) {
      this.dispatchBestEffort('safety');
      return;
    }
    if (this.safetyTimer !== null) return;
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      this.wake('safety');
    }, delayMs);
  }

  private cancelSafetyTimer(): void {
    if (this.safetyTimer === null) return;
    clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
  }

  private bridgeAbort(
    signal: AbortSignal | undefined,
    controller: AbortController | null,
  ): void {
    if (!signal || !controller || controller.signal.aborted) return;
    if (signal.aborted) {
      this.abortTraversal(controller, signal);
      return;
    }
    let listening = true;
    const cleanup = () => {
      if (!listening) return;
      listening = false;
      signal.removeEventListener('abort', abort);
      this.abortListenerCleanups.delete(cleanup);
    };
    const abort = () => {
      cleanup();
      if (this.activeController === controller && !controller.signal.aborted) {
        this.abortTraversal(controller, signal);
      }
    };
    this.abortListenerCleanups.add(cleanup);
    signal.addEventListener('abort', abort, { once: true });
  }

  private abortTraversal(controller: AbortController, signal: AbortSignal): void {
    // Wakes queued before cancellation belong to the canceled traversal. A
    // wake arriving after this boundary is preserved by the normal wake path.
    this.pendingMotionWake = false;
    controller.abort(abortReason(signal));
  }

  private cleanupAbortListeners(): void {
    [...this.abortListenerCleanups].forEach((cleanup) => cleanup());
  }

  private async openAndRunTraversal(signal: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      const traversal = await this.completedVideos.openTraversal(signal);
      try {
        await this.runTraversal(traversal, signal);
      } finally {
        await traversal.close();
      }
      throwIfAborted(signal);
    } catch (error) {
      // A cancelled traversal reports nothing about the scan root, so it
      // neither arms nor clears the latch. The second clause is the one that
      // does the work: `abortReason()` propagates a caller's non-`AbortError`
      // reason verbatim, and an adapter can reject with a raw filesystem error
      // when shutdown lands mid-syscall, so a cancellation can surface as an
      // arbitrary error. The first clause is defence in depth.
      if (!isAbortError(error) && signal?.aborted !== true) {
        this.recordScanFailure(error);
      }
      throw error;
    }

    this.clearScanFailures();
    await this.progress.motionTraversalCompleted(this.clock.now());
  }

  private async runTraversal(
    traversal: CompletedMotionVideoTraversal,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const batch = await this.registration.reconcileBatch(traversal, this.options, signal);
      throwIfAborted(signal);
      if (batch.complete) return;
      await yieldToEventLoop();
    }
  }

  /**
   * Counts one traversal outcome — never one awaiting caller — and raises a
   * single admin alert once the scan has failed `SCAN_FAILURE_ALERT_THRESHOLD`
   * times in a row, repeated no more than once per `SCAN_ALERT_REPEAT_MS`.
   * Alerting is best effort: it must not delay, mask or fail the traversal its
   * caller is awaiting.
   */
  private recordScanFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    const nowMs = this.clock.now();
    if (this.scanAlertAtMs !== null && nowMs - this.scanAlertAtMs < SCAN_ALERT_REPEAT_MS) return;
    if (this.consecutiveFailures < SCAN_FAILURE_ALERT_THRESHOLD) return;
    this.scanAlertAtMs = nowMs;
    const code = scanFailureCode(error);
    // The one line an operator wants timestamped: the moment a run of failures
    // became an outage. The DM carries the same code but needs a claimed admin
    // and a live bot, neither of which a fresh or unclaimed device has.
    this.logger.error(
      `Completed Motion scan failed ${this.consecutiveFailures} traversals in a row, `
      + `alerting admins: ${code ?? CAMERA_OPERATION_FAILED}`,
    );
    void Promise.resolve()
      .then(() => this.alerts.alert('motion-scan-failing', code))
      .catch(() => {
        this.logger.warn(`Completed Motion recovery alert failed: ${CAMERA_OPERATION_FAILED}`);
      });
  }

  private clearScanFailures(): void {
    this.consecutiveFailures = 0;
    this.scanAlertAtMs = null;
  }

  private dispatchBestEffort(reason: CompletedMotionRecoveryWakeReason): void {
    void this.startTraversal(reason).catch((error: unknown) => {
      if (isAbortError(error)) return;
      this.logger.error(
        `Completed Motion recovery failed: ${scanFailureCode(error) ?? CAMERA_OPERATION_FAILED}`,
      );
    });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

/** Only the Camera's own sanitized filesystem code may leave this context. */
function scanFailureCode(error: unknown): string | undefined {
  return error instanceof CompletedMotionVideoFilesystemError ? error.code : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
