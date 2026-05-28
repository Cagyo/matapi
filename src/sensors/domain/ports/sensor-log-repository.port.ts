export const SENSOR_LOG_REPOSITORY = Symbol('SENSOR_LOG_REPOSITORY');

export type SensorLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SensorLogEntry {
  sensorId: string;
  level: SensorLogLevel;
  message: string;
  timestamp: Date;
}

export interface SensorLogRepositoryPort {
  appendBatch(entries: SensorLogEntry[]): Promise<void>;
}
