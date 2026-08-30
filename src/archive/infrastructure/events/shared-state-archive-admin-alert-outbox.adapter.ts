import type { DriveCredentialRepositoryPort } from '../../application/ports/drive-credential-repository.port';
import type {
  ArchiveAdminAlertOutboxInput,
  ArchiveAdminAlertOutboxPort,
  ArchiveAdminAlertStateLockPort,
  ArchiveProviderProbeFailureSettlementInput,
} from '../../application/ports/archive-admin-alert-outbox.port';
import type {
  ArchiveProviderStateRepositoryPort,
  ArchiveProviderStateTransactionPort,
} from '../../application/ports/archive-provider-state-repository.port';
import type { EventRepositoryPort } from '../../../events/domain/ports/event-repository.port';
import type { QueuedEvent } from '../../../events/domain/queued-event.entity';

/** In-process parity adapter that serializes credential cooldown and event mutations. */
export class SharedStateArchiveAdminAlertOutboxAdapter implements ArchiveAdminAlertOutboxPort {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort,
      'loadActive' | 'readAlertCooldowns' | 'compareAndSetAlertCooldowns'>
      & ArchiveAdminAlertStateLockPort,
    private readonly events: Pick<EventRepositoryPort, 'enqueue'>,
    private readonly providerState?: ArchiveProviderStateRepositoryPort
      & ArchiveProviderStateTransactionPort,
  ) {}

  enqueue(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null> {
    return this.credentials.withArchiveAdminAlertStateLock(
      () => this.enqueueExclusive(input),
    );
  }

  settleProviderProbeFailure(
    input: ArchiveProviderProbeFailureSettlementInput,
  ): Promise<'settled' | 'lost'> {
    if (this.providerState === undefined) return Promise.resolve('lost');
    return this.providerState.withArchiveProviderStateTransaction(
      (providerState) => this.credentials.withArchiveAdminAlertStateLock(
        () => this.settleProviderProbeFailureExclusive(providerState, input),
      ),
    ).catch((error: unknown) => {
      if (error === LOST_SETTLEMENT) return 'lost';
      throw error;
    });
  }

  private async enqueueExclusive(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null> {
    const active = await this.credentials.loadActive();
    if (!sameFence(active, input.fence)) return null;
    const current = await this.credentials.readAlertCooldowns(input.fence.id);
    if (current === null || (current[input.kind] ?? 0) > input.nowMs) return null;
    const next = { ...current, [input.kind]: input.cooldownUntilMs };
    if (!await this.credentials.compareAndSetAlertCooldowns({
      generationId: input.fence.id,
      expected: current,
      next,
    })) return null;
    try {
      return await this.events.enqueue(toEvent(input));
    } catch (error) {
      await this.credentials.compareAndSetAlertCooldowns({
        generationId: input.fence.id,
        expected: next,
        next: current,
      });
      throw error;
    }
  }

  private async settleProviderProbeFailureExclusive(
    providerState: ArchiveProviderStateRepositoryPort,
    input: ArchiveProviderProbeFailureSettlementInput,
  ): Promise<'settled' | 'lost'> {
    const currentProviderState = await providerState.load();
    if (input.nextProviderState.generationId !== input.fence.id
      || input.nextProviderState.operationClass === null
      || currentProviderState.generationId !== input.fence.id
      || currentProviderState.revision !== input.expectedProviderRevision
      || currentProviderState.operationClass !== input.nextProviderState.operationClass) {
      return 'lost';
    }
    const active = await this.credentials.loadActive();
    if (!sameFence(active, input.fence)) return 'lost';
    const currentCooldowns = await this.credentials.readAlertCooldowns(input.fence.id);
    if (currentCooldowns === null) return 'lost';

    const providerUpdated = await providerState.compareAndSet(
      input.expectedProviderRevision,
      input.nextProviderState,
    );
    if (!providerUpdated) return 'lost';
    if ((currentCooldowns[input.alertKind] ?? 0) > input.nowMs) return 'settled';

    const nextCooldowns = {
      ...currentCooldowns,
      [input.alertKind]: Math.max(
        currentCooldowns[input.alertKind] ?? 0,
        input.alertCooldownUntilMs,
      ),
    };
    const cooldownUpdated = await this.credentials.compareAndSetAlertCooldowns({
      generationId: input.fence.id,
      expected: currentCooldowns,
      next: nextCooldowns,
    });
    if (!cooldownUpdated) {
      throw LOST_SETTLEMENT;
    }
    try {
      await this.events.enqueue(toEvent({
        fence: input.fence,
        kind: input.alertKind,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        nowMs: input.nowMs,
        cooldownUntilMs: input.alertCooldownUntilMs,
      }));
      return 'settled';
    } catch (error) {
      const cooldownRolledBack = await this.credentials.compareAndSetAlertCooldowns({
        generationId: input.fence.id,
        expected: nextCooldowns,
        next: currentCooldowns,
      });
      if (!cooldownRolledBack) {
        throw new Error('Archive provider probe settlement rollback failed');
      }
      throw error;
    }
  }
}

function sameFence(
  active: Awaited<ReturnType<DriveCredentialRepositoryPort['loadActive']>>,
  fence: ArchiveAdminAlertOutboxInput['fence'],
): boolean {
  return active?.id === fence.id
    && active.revision === fence.revision
    && active.status === fence.status;
}

function toEvent(input: ArchiveAdminAlertOutboxInput) {
  return {
    sensorId: null,
    type: 'archive_admin_alert',
    payload: {
      kind: input.kind,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    },
    createdAt: new Date(input.nowMs),
  };
}

const LOST_SETTLEMENT = new Error('Archive provider probe settlement lost its fence');
