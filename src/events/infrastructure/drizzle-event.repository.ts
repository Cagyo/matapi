import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { events } from '../../database/schema';
import {
  EVENT_QUEUE_OPTIONS,
  EventQueueOptions,
} from '../application/ports/event-queue-options.port';
import {
  NewQueuedEvent,
  QueuedEvent,
  QueuedEventPayload,
} from '../domain/queued-event.entity';
import { EventRepositoryPort } from '../domain/ports/event-repository.port';

type EventRow = typeof events.$inferSelect;

@Injectable()
export class DrizzleEventRepository implements EventRepositoryPort {
  private readonly logger = new Logger(DrizzleEventRepository.name);
  private overflowCount = 0;

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(EVENT_QUEUE_OPTIONS) private readonly options: EventQueueOptions,
  ) {}

  async enqueue(event: NewQueuedEvent): Promise<QueuedEvent> {
    const { queued, evicted } = this.db.transaction((tx) => {
      const [{ value }] = tx
        .select({ value: count() })
        .from(events)
        .where(isNull(events.sentAt))
        .all();
      let evicted = false;

      if (value >= this.options.maxUnsentEvents) {
        const oldest = tx
          .select({ id: events.id })
          .from(events)
          .where(isNull(events.sentAt))
          .orderBy(asc(events.createdAt), asc(events.id))
          .limit(1)
          .get();
        if (oldest) {
          tx.delete(events).where(eq(events.id, oldest.id)).run();
          evicted = true;
        }
      }

      const [row] = tx
        .insert(events)
        .values({
          sensorId: event.sensorId,
          type: event.type,
          payload: event.payload,
          createdAt: event.createdAt,
        })
        .returning()
        .all();

      return { queued: this.toQueuedEvent(row), evicted };
    });

    if (evicted) this.recordOverflow();
    return queued;
  }

  async pending(limit = 50): Promise<QueuedEvent[]> {
    return this.db
      .select()
      .from(events)
      .where(isNull(events.sentAt))
      .orderBy(asc(events.createdAt))
      .limit(limit)
      .all()
      .map((row) => this.toQueuedEvent(row));
  }

  async countPending(): Promise<number> {
    const [{ value }] = this.db
      .select({ value: count() })
      .from(events)
      .where(isNull(events.sentAt))
      .all();
    return value;
  }

  async markSent(ids: number[], sentAt: Date): Promise<void> {
    if (ids.length === 0) return;
    this.db.update(events).set({ sentAt }).where(inArray(events.id, ids)).run();
  }

  private toQueuedEvent(row: EventRow): QueuedEvent {
    return {
      id: row.id,
      sensorId: row.sensorId,
      type: row.type,
      payload: this.toPayload(row.payload),
      createdAt: row.createdAt,
    };
  }

  private toPayload(payload: unknown): QueuedEventPayload {
    if (payload === null || payload === undefined) return null;
    if (typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return { value: payload };
  }

  private recordOverflow(): void {
    this.overflowCount += 1;
    if (!isPowerOfTwo(this.overflowCount)) return;
    this.logger.warn(
      `Durable unsent queue overflow: count=${this.overflowCount}, bound=${this.options.maxUnsentEvents}`,
    );
  }
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && Number.isInteger(Math.log2(value));
}
