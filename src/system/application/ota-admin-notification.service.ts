import { Injectable } from "@nestjs/common";
import type {
  OtaAdminNotificationPort,
  OtaAdminNotice,
} from "../domain/ports/ota-admin-notification.port";

/**
 * System-owned runtime registration seam. Telegram supplies the outer adapter
 * at gateway bootstrap, avoiding a system-to-Telegram module dependency.
 */
@Injectable()
export class OtaAdminNotificationService implements OtaAdminNotificationPort {
  private delegate?: OtaAdminNotificationPort;

  register(delegate: OtaAdminNotificationPort): void {
    this.delegate = delegate;
  }

  clear(): void {
    this.delegate = undefined;
  }

  async deliver(notice: OtaAdminNotice): Promise<{ delivered: number }> {
    return this.delegate?.deliver(notice) ?? { delivered: 0 };
  }
}
