import { Injectable } from '@nestjs/common';
import { NotificationService } from '../../events/application/notification.service';
import { MotionAlertPort } from '../domain/ports/motion-alert.port';

/**
 * Production `MotionAlertPort` — delegates to the events notification pipeline
 * (spec 19, 20). Recipient fan-out, mute and quiet-hours filtering all live in
 * `NotificationService`; this adapter is the camera→events seam.
 */
@Injectable()
export class EventsMotionAlertAdapter implements MotionAlertPort {
  constructor(private readonly notifications: NotificationService) {}

  async motionStarted(
    cameraName: string,
    at: Date,
    photo: Buffer | null,
    cameraId?: string,
  ): Promise<void> {
    await this.notifications.notifyMotion(cameraName, at, photo, cameraId);
  }
}
