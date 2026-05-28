import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { sensorLogs } from '../../database/schema';
import {
  SensorLogEntry,
  SensorLogLevel,
  SensorLogQuery,
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';

type LogRow = typeof sensorLogs.$inferSelect;

@Injectable()
export class DrizzleSensorLogRepository implements SensorLogRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async appendBatch(entries: SensorLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.db.insert(sensorLogs).values(entries).run();
  }

  async findRecent(
    sensorId: string,
    query: SensorLogQuery,
  ): Promise<SensorLogEntry[]> {
    const where = query.since
      ? and(eq(sensorLogs.sensorId, sensorId), gte(sensorLogs.timestamp, query.since))
      : eq(sensorLogs.sensorId, sensorId);

    return this.db
      .select()
      .from(sensorLogs)
      .where(where)
      .orderBy(desc(sensorLogs.timestamp))
      .limit(query.limit)
      .all()
      .map((row) => this.toEntry(row));
  }

  private toEntry(row: LogRow): SensorLogEntry {
    return {
      sensorId: row.sensorId ?? '',
      level: (row.level as SensorLogLevel) ?? 'info',
      message: row.message,
      timestamp: row.timestamp ?? new Date(0),
    };
  }
}
