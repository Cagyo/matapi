import { Inject, Injectable } from '@nestjs/common';
import type { NotificationTargetRef } from '../domain/home-session';
import { NotificationTargetUnavailableError } from '../domain/errors/notification-target-unavailable.error';
import { USER_SENSOR_MUTE_REPOSITORY, type UserSensorMuteRepositoryPort } from '../domain/ports/user-sensor-mute-repository.port';
import { NotificationTargetDirectoryService } from './notification-target-directory.service';

@Injectable()
export class SetNotificationTargetMutedUseCase {
  constructor(
    private readonly targets: NotificationTargetDirectoryService,
    @Inject(USER_SENSOR_MUTE_REPOSITORY) private readonly mutes: UserSensorMuteRepositoryPort,
  ) {}

  async execute(userId: number, ref: NotificationTargetRef, muted: boolean): Promise<void> {
    const target = await this.targets.findEnabled(ref, userId);
    if (!target) throw new NotificationTargetUnavailableError(`${ref.kind}:${ref.id}`);
    if (target.muted === muted) return;
    if (muted) await this.mutes.mute(userId, target.ref);
    else await this.mutes.unmute(userId, target.ref);
  }
}
