import { Inject, Injectable } from '@nestjs/common';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import { MOTION_DESIRED_STATE_KEY } from '../domain/motion-desired-state';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';

/**
 * `/camera enable` — spec 14. Records the admin's intent (`desired=on`) so the
 * watcher keeps the daemon alive, then starts it (admin only).
 */
@Injectable()
export class EnableMotionUseCase {
  constructor(
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
  ) {}

  async execute(): Promise<void> {
    // Intent first: even if start() throws (already running / not installed),
    // the recorded intent matches what the admin asked for.
    await this.meta.set(MOTION_DESIRED_STATE_KEY, 'on');
    await this.motion.start();
  }
}
