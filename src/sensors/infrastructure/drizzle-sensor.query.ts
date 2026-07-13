import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { sensors, sensorsArchive } from '../../database/schema';
import {
  SensorHistoryPage,
  SensorHistoryTarget,
  SensorLookup,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';
import { buildSensorDashboardPage, SensorDashboardPage } from '../domain/sensor-dashboard-page';
import { Sensor, SensorSeverity, SensorType } from '../domain/sensor';
import { defaultDebounceMs } from '../domain/default-debounce';

type SensorRow = typeof sensors.$inferSelect;
type ArchivedRow = typeof sensorsArchive.$inferSelect;

interface SensorHistoryTargetRow {
  id: string;
  name: string;
  type: string;
  enabled: number;
  state: 'current' | 'archived';
  archivedAt: number | null;
}

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

  async listDashboardPage(input: { page: number; pageSize: 8 }): Promise<SensorDashboardPage> {
    return buildSensorDashboardPage(await this.listEnabled(), input);
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

  async listHistoryTargets(input: { page: number; pageSize: number }): Promise<SensorHistoryPage> {
    const countRow = this.db
      .all<{ count: number }>(
        sql`
        SELECT count(*) AS count
        FROM (
          SELECT ${sensors.id} AS id FROM ${sensors}
          UNION ALL
          SELECT ${sensorsArchive.id} AS id FROM ${sensorsArchive}
        )
      `,
      )
      .at(0);
    const total = countRow?.count ?? 0;
    const pageCount = Math.ceil(total / input.pageSize);

    if (pageCount === 0) return { targets: [], page: 0, pageCount: 0 };

    const page = Math.min(input.page, pageCount - 1);
    const offset = page * input.pageSize;
    const rows = this.db.all<SensorHistoryTargetRow>(sql`
      SELECT id, name, type, enabled, state, archived_at AS archivedAt
      FROM (
        SELECT
          ${sensors.id} AS id,
          ${sensors.name} AS name,
          ${sensors.type} AS type,
          ${sensors.enabled} AS enabled,
          'current' AS state,
          NULL AS archived_at,
          0 AS state_rank
        FROM ${sensors}
        UNION ALL
        SELECT
          ${sensorsArchive.id} AS id,
          ${sensorsArchive.name} AS name,
          ${sensorsArchive.type} AS type,
          0 AS enabled,
          'archived' AS state,
          ${sensorsArchive.archivedAt} AS archived_at,
          1 AS state_rank
        FROM ${sensorsArchive}
      )
      ORDER BY state_rank, name COLLATE NOCASE, id
      LIMIT ${input.pageSize} OFFSET ${offset}
    `);

    return {
      targets: rows.map((row) => this.toHistoryTarget(row)),
      page,
      pageCount,
    };
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
      type: row.type as SensorType,
      archivedAt: row.archivedAt ?? null,
    };
  }

  private toHistoryTarget(row: SensorHistoryTargetRow): SensorHistoryTarget {
    return {
      id: row.id,
      name: row.name,
      type: row.type as SensorType,
      enabled: Boolean(row.enabled),
      state: row.state,
      archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt * 1000),
    };
  }
}
