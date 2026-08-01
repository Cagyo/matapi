import { Injectable } from '@nestjs/common';
import type { EventQueueService } from '../../../events/application/event-queue.service';
import type { ClockPort } from '../../../events/domain/ports/clock.port';
import { en } from '../../../locales/en';
import type {
  ArchiveAdminAlert,
  ArchiveAdminAlertKind,
  ArchiveAdminAlertPort,
} from '../../application/ports/archive-admin-alert.port';
import type { ArchiveAdminAlertService } from '../../application/archive-admin-alert.service';

/** Persists a generic alert before the cooldown-limited Telegram delivery stage. */
@Injectable()
export class DurableArchiveAdminAlertAdapter implements ArchiveAdminAlertPort {
  constructor(
    private readonly queue: Pick<EventQueueService, 'enqueueSystemEvent'>,
    private readonly delivery: Pick<ArchiveAdminAlertService, 'alert'>,
    private readonly clock: ClockPort,
  ) {}

  async alert(
    kind: ArchiveAdminAlertKind,
    context: Omit<ArchiveAdminAlert, 'kind'>,
  ): Promise<void> {
    const alert: ArchiveAdminAlert = { ...context, kind };
    await this.queue.enqueueSystemEvent({
      type: 'archive_admin_alert',
      payload: {
        message: messageFor(alert),
        kind: alert.kind,
      },
      createdAt: this.clock.now(),
    });
    await this.delivery.alert(kind, context).catch(() => undefined);
  }
}

function messageFor(alert: ArchiveAdminAlert): string {
  return en.gdrive.alerts[alert.kind];
}
