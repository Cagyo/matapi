import { Sensor } from '../sensor';

export const SENSOR_REPOSITORY = Symbol('SENSOR_REPOSITORY');

export interface SensorRepositoryPort {
  /** All sensors with `enabled = true`. */
  loadEnabled(): Promise<Sensor[]>;
  /** Persist `lastValue` + `lastValueAt` for a sensor. */
  updateState(id: string, value: string, at: Date): Promise<void>;
}
