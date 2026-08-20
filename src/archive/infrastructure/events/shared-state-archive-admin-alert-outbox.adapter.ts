import type { DriveCredentialRepositoryPort } from '../../application/ports/drive-credential-repository.port';
import type {
  ArchiveAdminAlertOutboxInput,
  ArchiveAdminAlertOutboxPort,
  ArchiveAdminAlertStateLockPort,
} from '../../application/ports/archive-admin-alert-outbox.port';
import type { EventRepositoryPort } from '../../../events/domain/ports/event-repository.port';
import type { QueuedEvent } from '../../../events/domain/queued-event.entity';

/** In-process parity adapter that serializes credential cooldown and event mutations. */
export class SharedStateArchiveAdminAlertOutboxAdapter implements ArchiveAdminAlertOutboxPort {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort,
      'loadActive' | 'readAlertCooldowns' | 'compareAndSetAlertCooldowns'>
      & ArchiveAdminAlertStateLockPort,
    private readonly events: Pick<EventRepositoryPort, 'enqueue'>,
  ) {}

  enqueue(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null> {
    return this.credentials.withArchiveAdminAlertStateLock(
      () => this.enqueueExclusive(input),
    );
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
