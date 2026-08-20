import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { ArchiveRuntimeSignalPort } from '../../archive/application/ports/archive-runtime-signal.port';
import { CAMERA_MODE, type CameraMode } from '../camera.tokens';
import { CompletedMotionVideoFilesystemError } from '../domain/errors/completed-motion-video-filesystem.error';
import { ADMIN_ALERT, type AdminAlertPort } from '../domain/ports/admin-alert.port';
import type { CompletedMotionVideoScanCursor } from '../domain/ports/completed-motion-video.port';
import { RegisterCompletedMotionVideosUseCase } from './register-completed-motion-videos.use-case';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Consecutive failed traversals before admins are alerted. At the two-minute
 * safety tick a persistently unreadable scan root reaches this within roughly
 * four minutes, while a one-off transient filesystem error is ridden out.
 */
const SCAN_FAILURE_ALERT_THRESHOLD = 3;

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
  private cursor: CompletedMotionVideoScanCursor | null = null;
  private pendingWake = false;
  private consecutiveFailures = 0;
  private scanFailureAlerted = false;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    @Inject(RegisterCompletedMotionVideosUseCase)
    private readonly registration: Pick<RegisterCompletedMotionVideosUseCase, 'reconcileBatch'>,
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

  wake(_reason: CompletedMotionRecoveryWakeReason): void {
    if (this.mode !== 'real') return;
    if (this.inFlight !== null) {
      this.pendingWake = true;
      return;
    }
    this.dispatchBestEffort();
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    if (this.mode !== 'real') return Promise.resolve();
    if (this.inFlight !== null) {
      this.bridgeAbort(signal, this.activeController);
      return this.inFlight;
    }

    const controller = new AbortController();
    this.activeController = controller;
    this.bridgeAbort(signal, controller);
    const shared = this.runTraversal(controller.signal).finally(() => {
      if (this.inFlight !== shared) return;
      this.inFlight = null;
      this.cleanupAbortListeners();
      if (this.activeController === controller) this.activeController = null;
      if (this.pendingWake) {
        this.pendingWake = false;
        this.dispatchBestEffort();
      }
    });
    this.inFlight = shared;
    return shared;
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
    this.pendingWake = false;
    controller.abort(abortReason(signal));
  }

  private cleanupAbortListeners(): void {
    [...this.abortListenerCleanups].forEach((cleanup) => cleanup());
  }

  private async runTraversal(signal?: AbortSignal): Promise<void> {
    try {
      let cursor = copyCursor(this.cursor);
      while (true) {
        throwIfAborted(signal);
        const batch = await this.registration.reconcileBatch(copyCursor(cursor), signal);
        throwIfAborted(signal);
        if (batch.complete) {
          this.cursor = null;
          this.clearScanFailures();
          await this.progress.motionTraversalCompleted(this.clock.now());
          return;
        }
        if (batch.cursor === null) {
          throw new Error('Incomplete Motion traversal did not return a cursor');
        }
        cursor = copyCursor(batch.cursor);
        this.cursor = copyCursor(cursor);
        await yieldToEventLoop();
      }
    } catch (error) {
      this.cursor = null;
      // A cancelled traversal reports nothing about the scan root, so it
      // neither arms nor clears the latch.
      if (!isAbortError(error) && signal?.aborted !== true) {
        this.recordScanFailure(error);
      }
      throw error;
    }
  }

  /**
   * Counts one traversal outcome — never one awaiting caller — and raises a
   * single admin alert once the scan has failed `SCAN_FAILURE_ALERT_THRESHOLD`
   * times in a row. Alerting is best effort: it must not delay, mask or fail
   * the traversal its caller is awaiting.
   */
  private recordScanFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    if (this.scanFailureAlerted) return;
    if (this.consecutiveFailures < SCAN_FAILURE_ALERT_THRESHOLD) return;
    this.scanFailureAlerted = true;
    const code = scanFailureCode(error);
    void Promise.resolve()
      .then(() => this.alerts.alert('motion-scan-failing', code))
      .catch(() => {
        this.logger.warn('Completed Motion recovery alert failed');
      });
  }

  private clearScanFailures(): void {
    this.consecutiveFailures = 0;
    this.scanFailureAlerted = false;
  }

  private dispatchBestEffort(): void {
    void this.reconcile().catch((error: unknown) => {
      if (isAbortError(error)) return;
      this.logger.error('Completed Motion recovery failed');
    });
  }
}

function copyCursor(
  cursor: CompletedMotionVideoScanCursor | null,
): CompletedMotionVideoScanCursor | null {
  return cursor === null
    ? null
    : { frames: cursor.frames.map((frame) => ({ ...frame })) };
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
