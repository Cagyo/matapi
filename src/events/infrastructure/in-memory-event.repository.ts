import { Logger } from '@nestjs/common';
import { EventQueueOptions } from '../application/ports/event-queue-options.port';
import { NewQueuedEvent, QueuedEvent } from '../domain/queued-event.entity';
import { EventRepositoryPort } from '../domain/ports/event-repository.port';

type StoredQueuedEvent = QueuedEvent & { sentAt: Date | null };

export class InMemoryEventRepository implements EventRepositoryPort {
  private nextId = 1;
  private readonly events: StoredQueuedEvent[] = [];
  private readonly logger = new Logger(InMemoryEventRepository.name);
  private overflowCount = 0;

  constructor(
    private readonly options: Pick<EventQueueOptions, 'maxUnsentEvents'> = {
      maxUnsentEvents: 500,
    },
  ) {}

  async enqueue(event: NewQueuedEvent): Promise<QueuedEvent> {
    const unsent = this.events.filter((stored) => stored.sentAt === null);
    if (unsent.length >= this.options.maxUnsentEvents) {
      const oldest = [...unsent].sort(compareQueuedEvents)[0];
      const oldestIndex = this.events.findIndex((stored) => stored.id === oldest.id);
      this.events.splice(oldestIndex, 1);
      this.recordOverflow();
    }

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
      .sort(compareQueuedEvents)
      .slice(0, limit)
      .map((event) => this.toQueuedEvent(event));
  }

  async countPending(): Promise<number> {
    return this.events.filter((event) => event.sentAt === null).length;
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

  private recordOverflow(): void {
    this.overflowCount += 1;
    if (!isPowerOfTwo(this.overflowCount)) return;
    this.logger.warn(
      `Durable unsent queue overflow: count=${this.overflowCount}, bound=${this.options.maxUnsentEvents}`,
    );
  }
}

function compareQueuedEvents(left: QueuedEvent, right: QueuedEvent): number {
  const byCreatedAt = eventTime(left) - eventTime(right);
  return byCreatedAt === 0 ? left.id - right.id : byCreatedAt;
}

function eventTime(event: QueuedEvent): number {
  return event.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && Number.isInteger(Math.log2(value));
}
