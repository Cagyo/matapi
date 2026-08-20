import { Injectable } from '@nestjs/common';
import type { EventQueueService } from '../../../events/application/event-queue.service';
import type { NotificationService } from '../../../events/application/notification.service';
import type { ClockPort } from '../../../events/domain/ports/clock.port';
import type {
  ArchiveAdminAlert,
  ArchiveAdminAlertKind,
  ArchiveAdminAlertPort,
} from '../../application/ports/archive-admin-alert.port';
import {
  ARCHIVE_ADMIN_ALERT_COOLDOWN_MS,
  type ArchiveAdminAlertService,
} from '../../application/archive-admin-alert.service';

/** Persists a generic alert before the cooldown-limited Telegram delivery stage. */
@Injectable()
export class DurableArchiveAdminAlertAdapter implements ArchiveAdminAlertPort {
  constructor(
    private readonly queue: Pick<EventQueueService, 'enqueueArchiveAdminAlert'>,
    private readonly gate: Pick<ArchiveAdminAlertService, 'prepare'>,
    private readonly clock: ClockPort,
    private readonly immediate?: Pick<NotificationService, 'process'>,
  ) {}

  async alert(
    kind: ArchiveAdminAlertKind,
    context: Omit<ArchiveAdminAlert, 'kind'>,
  ): Promise<void> {
    const alert = await this.gate.prepare(kind, context);
    if (alert === null) return;
    const createdAt = this.clock.now();
    const queued = await this.queue.enqueueArchiveAdminAlert({
      generationId: alert.generationId,
      kind: alert.kind,
      nowMs: createdAt.getTime(),
      cooldownUntilMs: createdAt.getTime() + ARCHIVE_ADMIN_ALERT_COOLDOWN_MS,
      type: 'archive_admin_alert',
      payload: {
        kind: alert.kind,
        ...(alert.errorCode === undefined ? {} : { errorCode: alert.errorCode }),
      },
      createdAt,
    });
    if (queued === null) return;
    await this.immediate?.process(queued).catch(() => undefined);
  }
}
