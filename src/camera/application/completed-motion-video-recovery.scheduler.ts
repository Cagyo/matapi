import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { ArchiveRuntimeSignalPort } from '../../archive/application/ports/archive-runtime-signal.port';
import { CAMERA_MODE, type CameraMode } from '../camera.tokens';
import type { CompletedMotionVideoScanCursor } from '../domain/ports/completed-motion-video.port';
import { RegisterCompletedMotionVideosUseCase } from './register-completed-motion-videos.use-case';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;

export type CompletedMotionRecoveryWakeReason = 'boot' | 'motion-event' | 'safety';

interface RecoveryClock {
  now(): number;
}

const NOOP_PROGRESS: ArchiveRuntimeSignalPort = {
  motionTraversalCompleted: async () => undefined,
};

const SYSTEM_CLOCK: RecoveryClock = { now: Date.now };

/** Cooperatively drains one explicit filesystem traversal without overlapping it. */
@Injectable()
export class CompletedMotionVideoRecoveryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompletedMotionVideoRecoveryScheduler.name);
  private inFlight: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private readonly abortListenerCleanups = new Set<() => void>();
  private cursor: CompletedMotionVideoScanCursor | null = null;
  private pendingWake = false;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    @Inject(RegisterCompletedMotionVideosUseCase)
    private readonly registration: Pick<RegisterCompletedMotionVideosUseCase, 'reconcileBatch'>,
    @Optional() private readonly progress: ArchiveRuntimeSignalPort = NOOP_PROGRESS,
    @Optional() private readonly clock: RecoveryClock = SYSTEM_CLOCK,
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
      throw error;
    }
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
