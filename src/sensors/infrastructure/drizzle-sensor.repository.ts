import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { sensors, sensorsArchive } from '../../database/schema';
import {
  NewSensor,
  SensorPatch,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
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

  async findById(id: string): Promise<Sensor | null> {
    const row = this.db.select().from(sensors).where(eq(sensors.id, id)).get();
    return row ? this.toSensor(row) : null;
  }

  async findByName(name: string): Promise<Sensor | null> {
    const row = this.db.select().from(sensors).where(eq(sensors.name, name)).get();
    return row ? this.toSensor(row) : null;
  }

  async findActivePinOwner(pin: number): Promise<Sensor | null> {
    const candidates = this.db
      .select()
      .from(sensors)
      .where(and(eq(sensors.enabled, true), eq(sensors.type, 'digital')))
      .all();
    const match = candidates.find((row) => extractPin(row.config) === pin);
    return match ? this.toSensor(match) : null;
  }

  async create(sensor: NewSensor): Promise<Sensor> {
    this.db
      .insert(sensors)
      .values({
        id: sensor.id,
        name: sensor.name,
        type: sensor.type,
        config: sensor.config,
        enabled: true,
        debounceMs: sensor.debounceMs,
        severity: sensor.severity,
        createdAt: sensor.createdAt,
        updatedAt: sensor.createdAt,
      })
      .run();
    const row = this.db.select().from(sensors).where(eq(sensors.id, sensor.id)).get();
    if (!row) throw new Error(`create: row ${sensor.id} disappeared after insert`);
    return this.toSensor(row);
  }

  async update(id: string, patch: SensorPatch): Promise<Sensor> {
    const set: Partial<typeof sensors.$inferInsert> = { updatedAt: patch.updatedAt };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.config !== undefined) set.config = patch.config;
    if (patch.debounceMs !== undefined) set.debounceMs = patch.debounceMs;
    if (patch.severity !== undefined) set.severity = patch.severity;
    this.db.update(sensors).set(set).where(eq(sensors.id, id)).run();
    const row = this.db.select().from(sensors).where(eq(sensors.id, id)).get();
    if (!row) throw new Error(`update: sensor ${id} not found`);
    return this.toSensor(row);
  }

  async archive(id: string, archivedAt: Date): Promise<void> {
    const row = this.db.select().from(sensors).where(eq(sensors.id, id)).get();
    if (!row) throw new Error(`archive: sensor ${id} not found`);
    this.db.transaction((tx) => {
      tx.insert(sensorsArchive)
        .values({
          id: row.id,
          name: row.name,
          type: row.type,
          config: row.config,
          debounceMs: row.debounceMs,
          severity: row.severity,
          lastValue: row.lastValue,
          lastValueAt: row.lastValueAt,
          createdAt: row.createdAt,
          archivedAt,
        })
        .run();
      tx.delete(sensors).where(eq(sensors.id, id)).run();
    });
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

function extractPin(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const pin = (raw as Record<string, unknown>).pin;
  return typeof pin === 'number' ? pin : null;
}
