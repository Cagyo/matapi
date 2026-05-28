import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { sensors } from '../../database/schema';
import { SensorRepositoryPort } from '../domain/ports/sensor-repository.port';
import { Sensor, SensorSeverity, SensorType } from '../domain/sensor';

type SensorRow = typeof sensors.$inferSelect;

@Injectable()
export class DrizzleSensorRepository implements SensorRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async loadEnabled(): Promise<Sensor[]> {
    return this.db
      .select()
      .from(sensors)
      .where(eq(sensors.enabled, true))
      .all()
      .map((row) => this.toSensor(row));
  }

  async updateState(id: string, value: string, at: Date): Promise<void> {
    this.db
      .update(sensors)
      .set({ lastValue: value, lastValueAt: at, updatedAt: new Date() })
      .where(eq(sensors.id, id))
      .run();
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
