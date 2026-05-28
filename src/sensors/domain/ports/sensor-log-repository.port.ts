export const SENSOR_LOG_REPOSITORY = Symbol('SENSOR_LOG_REPOSITORY');

export type SensorLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SensorLogEntry {
  sensorId: string;
  level: SensorLogLevel;
  message: string;
  timestamp: Date;
}

export interface SensorLogQuery {
  /** Maximum rows to return, newest first. */
  limit: number;
  /** Inclusive lower bound on `timestamp`. Combined with `limit`. */
  since?: Date;
}

export interface SensorLogRepositoryPort {
  appendBatch(entries: SensorLogEntry[]): Promise<void>;
  /** Fetch recent log entries for one sensor, newest first. */
  findRecent(sensorId: string, query: SensorLogQuery): Promise<SensorLogEntry[]>;
}
