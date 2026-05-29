import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdminAlertPort,
  CameraAdminAlert,
} from '../../camera/domain/ports/admin-alert.port';
import { en } from '../../locales/en';
import {
  DIRECT_MESSENGER,
  DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';

/**
 * Telegram-side `AdminAlertPort` implementation (spec 20). Maps a camera admin
 * alert kind to localized text and DMs every admin. Registered into the
 * camera `AdminAlertService` at bot bootstrap to avoid a module cycle.
 */
@Injectable()
export class TelegramAdminAlertAdapter implements AdminAlertPort {
  private readonly logger = new Logger(TelegramAdminAlertAdapter.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
  ) {}

  async alert(kind: CameraAdminAlert, detail?: string): Promise<void> {
    const text = this.textFor(kind, detail);
    const recipients = await this.users.listRecipients();
    const admins = recipients.filter((user) => user.role === 'admin');
    await Promise.all(
      admins.map((admin) =>
        this.dm.send(admin.telegramId, text).catch((err) => {
          this.logger.warn(
            `Admin alert to ${admin.telegramId} failed: ${(err as Error).message}`,
          );
        }),
      ),
    );
  }

  private textFor(kind: CameraAdminAlert, detail?: string): string {
    switch (kind) {
      case 'motion-daemon-down':
        return en.camera.adminAlert.daemonDown;
      case 'motion-daemon-recovered':
        return en.camera.adminAlert.daemonRecovered;
      case 'gdrive-sync-failing':
        return en.camera.adminAlert.gdriveSyncFailing(detail ?? 'unknown error');
      case 'emergency-disk-cleanup':
        return en.camera.adminAlert.emergencyDiskCleanup;
    }
  }
}
