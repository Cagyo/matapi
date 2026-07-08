import { NewQueuedEvent, QueuedEvent } from '../queued-event.entity';

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');

export interface EventRepositoryPort {
  enqueue(event: NewQueuedEvent): Promise<QueuedEvent>;
  pending(limit?: number): Promise<QueuedEvent[]>;
  /** Total number of unsent events (used to decide force-aggregate). */
  countPending(): Promise<number>;
  markSent(ids: number[], sentAt: Date): Promise<void>;
}