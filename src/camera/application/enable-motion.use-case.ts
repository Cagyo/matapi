import { Inject, Injectable } from '@nestjs/common';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';

/** `/camera enable` — spec 14. Starts the Motion daemon (admin only). */
@Injectable()
export class EnableMotionUseCase {
  constructor(
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
  ) {}

  execute(): Promise<void> {
    return this.motion.start();
  }
}
