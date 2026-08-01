import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ArchiveAdminAlert,
  ArchiveAdminAlertDeliveryPort,
} from '../../archive/application/ports/archive-admin-alert.port';
import { catalogFor } from '../../locales';
import {
  DIRECT_MESSENGER,
  type DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../domain/ports/user-repository.port';

/** Private-only administrator delivery registered by the grammY bootstrapper. */
@Injectable()
export class TelegramArchiveAdminAlertAdapter implements ArchiveAdminAlertDeliveryPort {
  private readonly logger = new Logger(TelegramArchiveAdminAlertAdapter.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly messenger: DirectMessengerPort,
  ) {}

  async send(alert: ArchiveAdminAlert): Promise<void> {
    const recipients = await this.users.listRecipients();
    await Promise.all(recipients
      .filter((recipient) => recipient.role === 'admin')
      .map((recipient) => this.messenger.send(
        recipient.telegramId,
        catalogFor(recipient.locale).gdrive.alerts[alert.kind],
      ).catch(() => {
        this.logger.warn('Archive administrator alert recipient was unavailable');
      })));
  }
}
