import { Injectable, Logger } from '@nestjs/common';
import {
  AdminAlertPort,
  CameraAdminAlert,
} from '../domain/ports/admin-alert.port';

/**
 * Camera-owned `AdminAlertPort` with a runtime register/clear seam (mirrors
 * `EventNotifierService`). The concrete telegram adapter is registered at bot
 * bootstrap, avoiding a camera→telegram module cycle. Alerts raised while no
 * adapter is registered are dropped with a warning (best-effort).
 */
@Injectable()
export class AdminAlertService implements AdminAlertPort {
  private readonly logger = new Logger(AdminAlertService.name);
  private delegate?: AdminAlertPort;

  register(delegate: AdminAlertPort): void {
    this.delegate = delegate;
  }

  clear(): void {
    this.delegate = undefined;
  }

  async alert(kind: CameraAdminAlert): Promise<void> {
    if (!this.delegate) {
      this.logger.warn(`No admin-alert delegate registered; dropping "${kind}"`);
      return;
    }
    await this.delegate.alert(kind);
  }
}
