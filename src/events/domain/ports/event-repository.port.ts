import { NewQueuedEvent, QueuedEvent } from '../queued-event.entity';

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');

export interface ArchiveAdminAlertOutboxInput {
  generationId: string;
  kind: string;
  nowMs: number;
  cooldownUntilMs: number;
  event: NewQueuedEvent;
}

export interface EventRepositoryPort {
  enqueue(event: NewQueuedEvent): Promise<QueuedEvent>;
  /** Atomically accepts an archive-alert cooldown and inserts its durable outbox event. */
  enqueueArchiveAdminAlert(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null>;
  pending(limit?: number): Promise<QueuedEvent[]>;
  /** Total number of unsent events (used to decide force-aggregate). */
  countPending(): Promise<number>;
  markSent(ids: number[], sentAt: Date): Promise<void>;
}
