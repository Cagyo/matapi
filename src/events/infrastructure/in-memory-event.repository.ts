import { NewQueuedEvent, QueuedEvent } from '../domain/queued-event.entity';
import { EventRepositoryPort } from '../domain/ports/event-repository.port';

type StoredQueuedEvent = QueuedEvent & { sentAt: Date | null };

export class InMemoryEventRepository implements EventRepositoryPort {
  private nextId = 1;
  private readonly events: StoredQueuedEvent[] = [];

  async enqueue(event: NewQueuedEvent): Promise<QueuedEvent> {
    const queued: StoredQueuedEvent = {
      ...event,
      id: this.nextId,
      sentAt: null,
    };
    this.nextId += 1;
    this.events.push(queued);
    return this.toQueuedEvent(queued);
  }

  async pending(limit = 50): Promise<QueuedEvent[]> {
    return this.events
      .filter((event) => event.sentAt === null)
      .sort((left, right) => eventTime(left) - eventTime(right))
      .slice(0, limit)
      .map((event) => this.toQueuedEvent(event));
  }

  async markSent(ids: number[], sentAt: Date): Promise<void> {
    const idSet = new Set(ids);
    for (const event of this.events) {
      if (idSet.has(event.id)) {
        event.sentAt = sentAt;
      }
    }
  }

  sentAtFor(id: number): Date | null | undefined {
    return this.events.find((event) => event.id === id)?.sentAt;
  }

  private toQueuedEvent(event: StoredQueuedEvent): QueuedEvent {
    return {
      id: event.id,
      sensorId: event.sensorId,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    };
  }
}

function eventTime(event: QueuedEvent): number {
  return event.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
}