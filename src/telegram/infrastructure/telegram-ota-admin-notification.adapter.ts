import { Inject, Injectable, Logger } from "@nestjs/common";
import { catalogFor } from "../../locales/catalog";
import type {
  OtaAdminNotificationPort,
  OtaAdminNotice,
} from "../../system/domain/ports/ota-admin-notification.port";
import {
  DIRECT_MESSENGER,
  type DirectMessengerPort,
} from "../domain/ports/direct-messenger.port";
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from "../domain/ports/user-repository.port";

/** Telegram-owned rendering and admin-recipient selection for OTA notices. */
@Injectable()
export class TelegramOtaAdminNotificationAdapter implements OtaAdminNotificationPort {
  private readonly logger = new Logger(
    TelegramOtaAdminNotificationAdapter.name,
  );

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly messenger: DirectMessengerPort,
  ) {}

  async deliver(notice: OtaAdminNotice): Promise<{ delivered: number }> {
    const recipients = await this.users.listRecipients();
    const outcomes = await Promise.all(
      recipients
        .filter((recipient) => recipient.role === "admin")
        .map(async (admin) => {
          try {
            await this.messenger.send(
              admin.telegramId,
              this.render(notice, admin.locale),
            );
            return true;
          } catch {
            // Recipient identifiers and transport details remain in Telegram.
            this.logger.warn("OTA admin notice delivery failed");
            return false;
          }
        }),
    );
    return { delivered: outcomes.filter(Boolean).length };
  }

  private render(notice: OtaAdminNotice, locale: unknown): string {
    const catalog = catalogFor(locale);
    if (notice.kind === "release-available") {
      return catalog.ota.releaseAvailable(
        notice.version,
        notice.targetName,
        notice.commit.slice(0, 7),
      );
    }
    return catalog.ota.discoveryFailure(notice.code);
  }
}
