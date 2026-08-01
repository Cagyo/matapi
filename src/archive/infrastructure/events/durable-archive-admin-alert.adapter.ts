import { Injectable } from '@nestjs/common';
import type { EventQueueService } from '../../../events/application/event-queue.service';
import type { NotificationService } from '../../../events/application/notification.service';
import type { ClockPort } from '../../../events/domain/ports/clock.port';
import { en } from '../../../locales/en';
import type {
  ArchiveAdminAlert,
  ArchiveAdminAlertKind,
  ArchiveAdminAlertPort,
} from '../../application/ports/archive-admin-alert.port';

/** Persists the alert before an immediate best-effort administrator delivery. */
@Injectable()
export class DurableArchiveAdminAlertAdapter implements ArchiveAdminAlertPort {
  constructor(
    private readonly queue: Pick<EventQueueService, 'enqueueSystemEvent'>,
    private readonly notifications: Pick<NotificationService, 'process'>,
    private readonly clock: ClockPort,
  ) {}

  async alert(
    kind: ArchiveAdminAlertKind,
    context: Omit<ArchiveAdminAlert, 'kind'>,
  ): Promise<void> {
    const alert: ArchiveAdminAlert = { ...context, kind };
    const queued = await this.queue.enqueueSystemEvent({
      type: 'archive_admin_alert',
      payload: {
        artifactId: alert.artifactId,
        message: messageFor(alert),
        reason: alert.kind,
      },
      createdAt: this.clock.now(),
    });
    await this.notifications.process(queued);
  }
}

function messageFor(alert: ArchiveAdminAlert): string {
  return en.gdrive.alerts[alert.kind];
}
