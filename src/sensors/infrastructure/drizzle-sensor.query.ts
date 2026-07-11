import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { sensors, sensorsArchive } from '../../database/schema';
import {
  SensorLookup,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';
import { Sensor, SensorSeverity, SensorType } from '../domain/sensor';
import { defaultDebounceMs } from '../domain/default-debounce';

type SensorRow = typeof sensors.$inferSelect;
type ArchivedRow = typeof sensorsArchive.$inferSelect;

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

  async findByIdIncludingArchived(id: string): Promise<SensorLookup | null> {
    const active = this.db.select().from(sensors).where(eq(sensors.id, id)).get();
    if (active) return { kind: 'active', sensor: this.toSensor(active) };

    const archived = this.db
      .select()
      .from(sensorsArchive)
      .where(eq(sensorsArchive.id, id))
      .get();
    if (archived) return { kind: 'archived', sensor: this.toArchived(archived) };

    return null;
  }

  async findByName(name: string): Promise<SensorLookup | null> {
    const active = this.db
      .select()
      .from(sensors)
      .where(eq(sensors.name, name))
      .get();
    if (active) return { kind: 'active', sensor: this.toSensor(active) };

    const archived = this.db
      .select()
      .from(sensorsArchive)
      .where(eq(sensorsArchive.name, name))
      .get();
    if (archived) return { kind: 'archived', sensor: this.toArchived(archived) };

    return null;
  }

  private toSensor(row: SensorRow): Sensor {
    const type = row.type as SensorType;
    return {
      id: row.id,
      name: row.name,
      type,
      config: (row.config as Record<string, unknown>) ?? {},
      enabled: row.enabled ?? true,
      debounceMs: row.debounceMs ?? defaultDebounceMs(type),
      severity: (row.severity as SensorSeverity) ?? 'info',
      lastValue: row.lastValue ?? null,
      lastValueAt: row.lastValueAt ?? null,
    };
  }

  private toArchived(row: ArchivedRow) {
    return {
      id: row.id,
      name: row.name,
      archivedAt: row.archivedAt ?? null,
    };
  }
}
