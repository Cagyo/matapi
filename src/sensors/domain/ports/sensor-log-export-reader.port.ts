import { SensorLogLevel } from './sensor-log-repository.port';

export const SENSOR_LOG_EXPORT_READER = Symbol('SENSOR_LOG_EXPORT_READER');

export interface SensorLogExportRow {
  readonly id: number;
  readonly level: SensorLogLevel;
  readonly message: string;
  readonly timestamp: Date | null;
}

export interface SensorLogExportReaderPort {
  withRows(
    sensorId: string,
    options: { limit: number; maxMessageBytes: number },
    consume: (rows: Iterable<SensorLogExportRow>) => void,
  ): void;
}
