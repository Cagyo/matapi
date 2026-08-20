import { Injectable } from '@nestjs/common';
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
import type { ArchiveAdminAlertOutboxPort } from '../../application/ports/archive-admin-alert-outbox.port';

/** Persists a generic alert before the cooldown-limited Telegram delivery stage. */
@Injectable()
export class DurableArchiveAdminAlertAdapter implements ArchiveAdminAlertPort {
  constructor(
    private readonly outbox: ArchiveAdminAlertOutboxPort,
    private readonly gate: Pick<ArchiveAdminAlertService, 'prepare'>,
    private readonly clock: ClockPort,
    private readonly immediate?: Pick<NotificationService, 'process'>,
  ) {}

  async alert(
    kind: ArchiveAdminAlertKind,
    context: Omit<ArchiveAdminAlert, 'kind'>,
  ): Promise<void> {
    const prepared = await this.gate.prepare(kind, context);
    if (prepared === null) return;
    const createdAt = this.clock.now();
    const queued = await this.outbox.enqueue({
      fence: prepared.fence,
      kind: prepared.alert.kind,
      ...(prepared.alert.errorCode === undefined ? {} : { errorCode: prepared.alert.errorCode }),
      nowMs: createdAt.getTime(),
      cooldownUntilMs: createdAt.getTime() + ARCHIVE_ADMIN_ALERT_COOLDOWN_MS,
    });
    if (queued === null) return;
    await this.immediate?.process(queued).catch(() => undefined);
  }
}
