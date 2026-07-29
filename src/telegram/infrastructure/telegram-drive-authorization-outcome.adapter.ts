import { Inject, Injectable } from '@nestjs/common';
import { catalogFor } from '../../locales';
import type { DriveAuthorizationOutcome, DriveAuthorizationOutcomePort } from '../../archive/application/ports/drive-authorization-outcome.port';
import { DIRECT_MESSENGER, type DirectMessengerPort } from '../domain/ports/direct-messenger.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../domain/ports/user-repository.port';

/** Delivers device-code outcomes without exposing device codes, tokens, or client material. */
@Injectable()
export class TelegramDriveAuthorizationOutcomeAdapter implements DriveAuthorizationOutcomePort {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly messenger: DirectMessengerPort,
  ) {}

  async publish(outcome: DriveAuthorizationOutcome): Promise<void> {
    const user = await this.users.findByTelegramId(outcome.adminUserId);
    if (!user || user.role !== 'admin') return;
    const catalog = catalogFor(user.locale);
    if (outcome.kind === 'authorized') {
      const account = outcome.account.displayName ?? outcome.account.email ?? catalog.gdriveConnection.accountUnavailable;
      await this.messenger.send(outcome.adminUserId, catalog.gdriveConnection.authorizationReady(account));
      return;
    }
    await this.messenger.send(outcome.adminUserId, catalog.gdriveConnection.authorizationFailed);
  }
}
