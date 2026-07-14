import { Injectable } from '@nestjs/common';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../domain/errors/sensor-not-muted.error';
import { NotificationTargetDirectoryService } from './notification-target-directory.service';
import { SetNotificationTargetMutedUseCase } from './set-notification-target-muted.use-case';

/** Spec 12 — `/unmute <sensor>`. */
@Injectable()
export class UnmuteSensorUseCase {
  constructor(
    private readonly targets: NotificationTargetDirectoryService,
    private readonly setMuted: SetNotificationTargetMutedUseCase,
  ) {}

  async execute(userId: number, sensorName: string): Promise<void> {
    const target = await this.targets.findEnabledByName(sensorName, userId);
    if (!target) throw new SensorNotFoundError(sensorName);
    if (!target.muted) throw new SensorNotMutedError(target.name);
    await this.setMuted.execute(userId, target.ref, false);
  }
}
