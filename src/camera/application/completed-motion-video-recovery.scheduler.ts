import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CAMERA_MODE, type CameraMode } from '../camera.tokens';
import { RegisterCompletedMotionVideosUseCase } from './register-completed-motion-videos.use-case';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;

/** Boots and periodically reconciles Motion files while preventing overlap. */
@Injectable()
export class CompletedMotionVideoRecoveryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompletedMotionVideoRecoveryScheduler.name);
  private running = false;

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    private readonly registration: Pick<RegisterCompletedMotionVideosUseCase, 'reconcile'>,
  ) {}

  onApplicationBootstrap(): void {
    void this.run();
  }

  @Interval('completed-motion-video-recovery', RECOVERY_INTERVAL_MS)
  reconcileTick(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.mode !== 'real' || this.running) return;
    this.running = true;
    try {
      await this.registration.reconcile();
    } catch (error) {
      this.logger.error(`Completed Motion recovery failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
