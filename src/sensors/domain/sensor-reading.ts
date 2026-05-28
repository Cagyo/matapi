export interface SensorReading {
  value: string | number | boolean;
  timestamp: Date;
  raw?: unknown;
}
