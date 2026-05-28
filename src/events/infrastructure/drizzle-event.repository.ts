import { Inject, Injectable } from '@nestjs/common';
import { asc, inArray, isNull } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { events } from '../../database/schema';
import {
  NewQueuedEvent,
  QueuedEvent,
  QueuedEventPayload,
} from '../domain/queued-event.entity';
import { EventRepositoryPort } from '../domain/ports/event-repository.port';

type EventRow = typeof events.$inferSelect;

@Injectable()
export class DrizzleEventRepository implements EventRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async enqueue(event: NewQueuedEvent): Promise<QueuedEvent> {
    const [row] = this.db
      .insert(events)
      .values({
        sensorId: event.sensorId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      })
      .returning()
      .all();

    return this.toQueuedEvent(row);
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
}