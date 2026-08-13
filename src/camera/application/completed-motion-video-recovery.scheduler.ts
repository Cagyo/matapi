import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CAMERA_MODE, type CameraMode } from '../camera.tokens';
import { RegisterCompletedMotionVideosUseCase } from './register-completed-motion-videos.use-case';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;

/** Boots and periodically reconciles Motion files while preventing overlap. */
@Injectable()
export class CompletedMotionVideoRecoveryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompletedMotionVideoRecoveryScheduler.name);
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    @Inject(RegisterCompletedMotionVideosUseCase)
    private readonly registration: Pick<RegisterCompletedMotionVideosUseCase, 'reconcile'>,
  ) {}

  onApplicationBootstrap(): void {
    this.dispatchBestEffort();
  }

  @Interval('completed-motion-video-recovery', RECOVERY_INTERVAL_MS)
  reconcileTick(): void {
    this.dispatchBestEffort();
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    if (this.mode !== 'real') return Promise.resolve();
    if (this.inFlight !== null) return this.inFlight;

    const shared = Promise.resolve()
      .then(() => this.registration.reconcile(signal))
      .finally(() => {
        if (this.inFlight === shared) this.inFlight = null;
      });
    this.inFlight = shared;
    return shared;
  }

  private dispatchBestEffort(): void {
    void this.reconcile().catch(() => {
      this.logger.error('Completed Motion recovery failed');
    });
  }
}
