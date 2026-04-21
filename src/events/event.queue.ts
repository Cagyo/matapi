import { Inject, Injectable, Logger } from '@nestjs/common';
import { isNull, asc, inArray } from 'drizzle-orm';
import { DB, AppDatabase } from '../database/database.module';
import { events } from '../database/schema';
import { SensorEvent } from '../sensors/sensor.interface';

export interface QueuedEvent {
  id: number;
  sensorId: string | null;
  type: string;
  payload: any;
  createdAt: Date | null;
}

@Injectable()
export class EventQueue {
  private readonly logger = new Logger(EventQueue.name);

  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  enqueue(event: SensorEvent): QueuedEvent {
    const [row] = this.db
      .insert(events)
      .values({
        sensorId: event.sensorId,
        type: event.type === 'state_change' ? 'state_change' : 'system',
        payload: {
          oldValue: event.oldValue,
          newValue: event.newValue,
        },
        createdAt: event.timestamp,
      })
      .returning()
      .all();

    return {
      id: row.id,
      sensorId: row.sensorId,
      type: row.type,
      payload: row.payload,
      createdAt: row.createdAt,
    };
  }

  pending(limit = 50): QueuedEvent[] {
    return this.db
      .select()
      .from(events)
      .where(isNull(events.sentAt))
      .orderBy(asc(events.createdAt))
      .limit(limit)
      .all()
      .map((row) => ({
        id: row.id,
        sensorId: row.sensorId,
        type: row.type,
        payload: row.payload,
        createdAt: row.createdAt,
      }));
  }

  markSent(ids: number[], sentAt: Date = new Date()): void {
    if (ids.length === 0) return;
    this.db.update(events).set({ sentAt }).where(inArray(events.id, ids)).run();
  }
}
