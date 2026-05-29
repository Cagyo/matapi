import { Injectable, Logger } from '@nestjs/common';
import { MotionAlertPort } from '../domain/ports/motion-alert.port';

/** Dev/test `MotionAlertPort` — logs instead of notifying. */
@Injectable()
export class StubMotionAlertAdapter implements MotionAlertPort {
  private readonly logger = new Logger(StubMotionAlertAdapter.name);

  async motionStarted(
    cameraName: string,
    at: Date,
    photo: Buffer | null,
  ): Promise<void> {
    this.logger.warn(
      `StubMotionAlert: motion on ${cameraName} at ${at.toISOString()} (photo: ${
        photo ? `${photo.length}B` : 'none'
      })`,
    );
  }
}
