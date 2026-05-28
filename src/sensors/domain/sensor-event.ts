export type SensorEventType = 'state_change' | 'threshold' | 'error';

export interface SensorEvent {
  sensorId: string;
  type: SensorEventType;
  oldValue?: unknown;
  newValue: unknown;
  timestamp: Date;
}
