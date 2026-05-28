import { Sensor } from '../sensor';

export const SENSOR_QUERY = Symbol('SENSOR_QUERY');

/**
 * Read-only projection of sensor state for cross-context consumers
 * (e.g. telegram `/status`, events queue enrichment). Does NOT expose
 * driver internals or mutation methods — use `SensorRepositoryPort` for
 * writes inside the sensors context.
 */
export interface SensorQueryPort {
  /** All sensors with `enabled = true`. */
  listEnabled(): Promise<Sensor[]>;
  /** Single sensor by id, or `null` if missing/disabled. */
  findById(id: string): Promise<Sensor | null>;
}
