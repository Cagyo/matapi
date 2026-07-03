import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { ImportedSensor } from '../domain/config-import';
import {
  NewSensor,
  SENSOR_REPOSITORY,
  SensorImportBatch,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { Sensor } from '../domain/sensor';
import { ReloadSensorsUseCase } from './reload-sensors.use-case';

/** One changed sensor in the import summary, with a short human reason. */
export interface ImportUpdateSummary {
  name: string;
  detail: string;
}

/** Human-readable diff of a prepared import vs. the current config. */
export interface ImportSummary {
  added: string[];
  updated: ImportUpdateSummary[];
  archived: string[];
}

/** A validated, diffed import awaiting confirmation (spec 16). */
export interface ImportPlan {
  batch: SensorImportBatch;
  summary: ImportSummary;
}

/**
 * Spec 16 § /import_config. Full-replacement import of the `sensors` table:
 *
 * - `prepare` diffs the validated import against the current active sensors
 *   and produces a plan + human summary (no writes).
 * - `commit` applies the plan atomically (one transaction) then hot-reloads
 *   the live sensor pipeline.
 *
 * Cross-sensor validation (name/pin uniqueness, threshold ordering) is done
 * by `validateImportConfig` before `prepare` is called.
 */
@Injectable()
export class ImportSensorsUseCase {
  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(forwardRef(() => ReloadSensorsUseCase))
    private readonly reload: ReloadSensorsUseCase,
  ) {}

  async prepare(imported: ImportedSensor[]): Promise<ImportPlan> {
    const current = await this.repository.loadEnabled();
    const now = this.clock.now();
    const currentByName = new Map(current.map((s) => [s.name, s]));
    const importedNames = new Set(imported.map((s) => s.name));

    const inserts: NewSensor[] = [];
    const updates: SensorImportBatch['updates'] = [];
    const added: string[] = [];
    const updated: ImportUpdateSummary[] = [];

    for (const entry of imported) {
      const existing = currentByName.get(entry.name);
      if (!existing) {
        inserts.push({
          id: randomUUID(),
          name: entry.name,
          type: entry.type,
          config: entry.config,
          debounceMs: entry.debounceMs,
          severity: entry.severity,
          createdAt: now,
        });
        added.push(entry.name);
        continue;
      }
      const detail = describeChange(existing, entry);
      if (detail) {
        updates.push({
          id: existing.id,
          patch: {
            config: entry.config,
            debounceMs: entry.debounceMs,
            severity: entry.severity,
            updatedAt: now,
          },
        });
        updated.push({ name: entry.name, detail });
      }
    }

    const removed = current.filter((s) => !importedNames.has(s.name));
    const archives = removed.map((s) => ({ id: s.id, archivedAt: now }));
    const archived = removed.map((s) => s.name);

    return {
      batch: { inserts, updates, archives },
      summary: { added, updated, archived },
    };
  }

  async commit(plan: ImportPlan): Promise<ImportSummary> {
    await this.repository.applyImport(plan.batch);
    await this.reload.execute();
    return plan.summary;
  }
}

/** Build a short reason describing how `entry` differs from `existing`, or `null`. */
function describeChange(existing: Sensor, entry: ImportedSensor): string | null {
  const reasons: string[] = [];

  if (existing.type === 'digital') {
    const before = numberOrNull(existing.config.pin);
    const after = numberOrNull(entry.config.pin);
    if (before !== after) reasons.push(`pin ${before ?? '?'}→${after ?? '?'}`);
  }

  if (existing.type === 'uart') {
    const before = JSON.stringify(thresholdsOf(existing.config));
    const after = JSON.stringify(thresholdsOf(entry.config));
    if (before !== after) reasons.push('thresholds changed');
  }

  if (JSON.stringify(existing.config) !== JSON.stringify(entry.config)) {
    if (reasons.length === 0) reasons.push('config changed');
  }

  if (existing.severity !== entry.severity) reasons.push('severity changed');
  if (existing.debounceMs !== entry.debounceMs) reasons.push('debounce changed');

  return reasons.length > 0 ? reasons.join(', ') : null;
}

function thresholdsOf(config: Record<string, unknown>): unknown {
  return (config as { thresholds?: unknown }).thresholds ?? null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
