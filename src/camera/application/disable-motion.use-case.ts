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
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

/**
 * `/camera disable` — spec 14. Records the admin's intent (`desired=off`) so
 * the watcher does NOT auto-restart, then stops the daemon (admin only).
 */
@Injectable()
export class DisableMotionUseCase {
  constructor(
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async execute(): Promise<void> {
    await this.availability?.requireReady('motion');
    await this.meta.set(MOTION_DESIRED_STATE_KEY, 'off');
    await this.availability?.requireReady('motion');
    await this.motion.stop();
  }
}
