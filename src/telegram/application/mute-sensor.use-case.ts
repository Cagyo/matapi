import { Injectable } from '@nestjs/common';
import { SensorAlreadyMutedError } from '../domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { NotificationTargetDirectoryService } from './notification-target-directory.service';
import { SetNotificationTargetMutedUseCase } from './set-notification-target-muted.use-case';

/** Spec 12 — `/mute <sensor>`. Per-user, per-sensor notification mute. */
@Injectable()
export class MuteSensorUseCase {
  constructor(
    private readonly targets: NotificationTargetDirectoryService,
    private readonly setMuted: SetNotificationTargetMutedUseCase,
  ) {}

  async execute(userId: number, sensorName: string): Promise<void> {
    const target = await this.targets.findEnabledByName(sensorName, userId);
    if (!target) throw new SensorNotFoundError(sensorName);
    if (target.muted) throw new SensorAlreadyMutedError(target.name);
    await this.setMuted.execute(userId, target.ref, true);
  }
}
