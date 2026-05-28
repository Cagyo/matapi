import { SensorEvent } from '../sensor-event';

export const SENSOR_EVENT_SOURCE = Symbol('SENSOR_EVENT_SOURCE');

export interface SensorEventSourcePort {
  onEvent(callback: (event: SensorEvent) => void): void;
}