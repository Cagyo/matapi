import { Inject, Injectable } from '@nestjs/common';
import {
  NotificationRecipient,
  RecipientDirectoryPort,
} from '../../events/domain/ports/recipient.port';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import {
  USER_SENSOR_MUTE_REPOSITORY,
  UserSensorMuteRepositoryPort,
} from '../domain/ports/user-sensor-mute-repository.port';

/**
 * Telegram-side implementation of the events-owned `RecipientDirectoryPort`
 * (spec 19). Projects registered users and their per-sensor mutes into the
 * shape the notification pipeline needs. Bound at runtime via
 * `RecipientDirectoryService.register()` from `GrammyBotGateway`, mirroring
 * the `NotifierPort` seam.
 */
@Injectable()
export class TelegramRecipientDirectoryAdapter implements RecipientDirectoryPort {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(USER_SENSOR_MUTE_REPOSITORY)
    private readonly mutes: UserSensorMuteRepositoryPort,
  ) {}

  async listRecipients(): Promise<NotificationRecipient[]> {
    const users = await this.users.listRecipients();
    return users.map((user) => ({
      telegramId: user.telegramId,
      muted: user.muted,
      nonCriticalPausedUntil: user.nonCriticalPausedUntil,
      quietStart: user.quietStart,
      quietEnd: user.quietEnd,
    }));
  }

  async isSensorMuted(telegramId: number, sensorId: string): Promise<boolean> {
    return this.mutes.isMuted(telegramId, sensorId);
  }
}
