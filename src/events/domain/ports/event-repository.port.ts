import { NewQueuedEvent, QueuedEvent } from '../queued-event.entity';

export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');

export interface EventRepositoryPort {
  enqueue(event: NewQueuedEvent): Promise<QueuedEvent>;
  pending(limit?: number): Promise<QueuedEvent[]>;
  markSent(ids: number[], sentAt: Date): Promise<void>;
}