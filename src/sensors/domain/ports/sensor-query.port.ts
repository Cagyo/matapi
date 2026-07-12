import { Sensor, SensorType } from '../sensor';

export const SENSOR_QUERY = Symbol('SENSOR_QUERY');

/** Archived sensor row, returned by `findByName` when no longer active. */
export interface ArchivedSensor {
  id: string;
  name: string;
  type: SensorType;
  archivedAt: Date | null;
}

export type SensorLookup =
  | { kind: 'active'; sensor: Sensor }
  | { kind: 'archived'; sensor: ArchivedSensor };

export interface SensorHistoryTarget {
  readonly id: string;
  readonly name: string;
  readonly type: SensorType;
  readonly enabled: boolean;
  readonly state: 'current' | 'archived';
  readonly archivedAt: Date | null;
}

export interface SensorHistoryPage {
  readonly targets: readonly SensorHistoryTarget[];
  readonly page: number;
  readonly pageCount: number;
}

/**
 * Read-only projection of sensor state for cross-context consumers
 * (e.g. telegram `/status`, `/logs`, events queue enrichment).
 * Mutations go through `SensorRepositoryPort`.
 */
export interface SensorQueryPort {
  /** All sensors with `enabled = true`. */
  listEnabled(): Promise<Sensor[]>;
  /** Single sensor by id, or `null` if missing/disabled. */
  findById(id: string): Promise<Sensor | null>;
  /** Active, disabled, or archived sensor by ID; used for historical log links. */
  findByIdIncludingArchived(id: string): Promise<SensorLookup | null>;
  /**
   * Resolve a sensor by name. Looks up the active set first, then the
   * archive (spec 09 — `/logs` on archived sensors). Returns `null` if
   * neither contains the name.
   */
  findByName(name: string): Promise<SensorLookup | null>;
  /** Current and archived sensors available as history-export targets. */
  listHistoryTargets(input: { page: number; pageSize: number }): Promise<SensorHistoryPage>;
}
