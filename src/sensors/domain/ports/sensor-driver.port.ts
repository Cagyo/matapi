import { SensorConfig, SensorType } from '../sensor';
import { SensorEvent } from '../sensor-event';
import { SensorReading } from '../sensor-reading';

export const SENSOR_DRIVER_FACTORY = Symbol('SENSOR_DRIVER_FACTORY');

/**
 * Bounded shutdown budget supplied by the application lifecycle owner.
 *
 * Drivers must synchronously disable listeners, timers, and callbacks, then
 * use this signal/deadline to bound any third-party cleanup that can hang.
 * The contract intentionally contains only platform types so application and
 * domain code never depend on a concrete sensor transport.
 */
export interface SensorDriverShutdownContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export interface SensorDriverPort {
  init(config: SensorConfig): Promise<void>;
  destroy(context?: SensorDriverShutdownContext): Promise<void>;
  getState(): SensorReading;
  onEvent(callback: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}

export type SensorDriverFactory = (type: SensorType) => SensorDriverPort;
