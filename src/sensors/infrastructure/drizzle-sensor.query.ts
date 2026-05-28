import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { sensors } from '../../database/schema';
import { SensorQueryPort } from '../domain/ports/sensor-query.port';
import { Sensor, SensorSeverity, SensorType } from '../domain/sensor';

type SensorRow = typeof sensors.$inferSelect;

@Injectable()
export class DrizzleSensorQuery implements SensorQueryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async listEnabled(): Promise<Sensor[]> {
    return this.db
      .select()
      .from(sensors)
      .where(eq(sensors.enabled, true))
      .all()
      .map((row) => this.toSensor(row));
  }

  async findById(id: string): Promise<Sensor | null> {
    const row = this.db.select().from(sensors).where(eq(sensors.id, id)).get();
    if (!row || row.enabled === false) return null;
    return this.toSensor(row);
  }

  private toSensor(row: SensorRow): Sensor {
    return {
      id: row.id,
      name: row.name,
      type: row.type as SensorType,
      config: (row.config as Record<string, unknown>) ?? {},
      enabled: row.enabled ?? true,
      debounceMs: row.debounceMs ?? 10000,
      severity: (row.severity as SensorSeverity) ?? 'info',
      lastValue: row.lastValue ?? null,
      lastValueAt: row.lastValueAt ?? null,
    };
  }
}
