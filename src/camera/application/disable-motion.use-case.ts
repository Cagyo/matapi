import { Inject, Injectable } from '@nestjs/common';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';

/** `/camera disable` — spec 14. Stops the Motion daemon (admin only). */
@Injectable()
export class DisableMotionUseCase {
  constructor(
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
  ) {}

  execute(): Promise<void> {
    return this.motion.stop();
  }
}
