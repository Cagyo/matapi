import type { QueuedEvent } from '../../../events/domain/queued-event.entity';
import type { ArchiveProviderState } from './archive-provider-state-repository.port';
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

export interface ArchiveProviderProbeFailureSettlementInput {
  fence: ArchiveAdminAlertActiveFence;
  expectedProviderRevision: number;
  nextProviderState: Omit<ArchiveProviderState, 'revision'>;
  alertKind:
    | 'quota-reclamation-required'
    | 'provider-capacity-blocked'
    | 'policy-rejected';
  errorCode?: string;
  nowMs: number;
  alertCooldownUntilMs: number;
}

export interface ArchiveAdminAlertOutboxPort {
  enqueue(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null>;
  settleProviderProbeFailure(
    input: ArchiveProviderProbeFailureSettlementInput,
  ): Promise<'settled' | 'lost'>;
}

/** Optional in-process transaction boundary for shared credential and alert state. */
export interface ArchiveAdminAlertStateLockPort {
  withArchiveAdminAlertStateLock<T>(operation: () => Promise<T>): Promise<T>;
}
