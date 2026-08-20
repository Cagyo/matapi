import type { QueuedEvent } from '../../../events/domain/queued-event.entity';
import type { ArchiveAdminAlertKind } from './archive-admin-alert.port';

export const ARCHIVE_ADMIN_ALERT_OUTBOX = Symbol('ARCHIVE_ADMIN_ALERT_OUTBOX');

export interface ArchiveAdminAlertActiveFence {
  id: string;
  revision: number;
  status: 'active' | 'reauth_required';
}

export interface ArchiveAdminAlertOutboxInput {
  fence: ArchiveAdminAlertActiveFence;
  kind: ArchiveAdminAlertKind;
  errorCode?: string;
  nowMs: number;
  cooldownUntilMs: number;
}

export interface ArchiveAdminAlertOutboxPort {
  enqueue(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null>;
}
