import { Injectable, Logger } from '@nestjs/common';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';

/**
 * Mock GPIO adapter for development. State changes are triggered manually via
 * `simulateChange()` (e.g. from the future dev simulator HTTP panel).
 */
@Injectable()
export class MockGpioAdapter implements SensorDriverPort {
  private readonly logger = new Logger(MockGpioAdapter.name);
  private config?: SensorConfig;
  private currentValue: 0 | 1 = 0;
  private lastTimestamp = new Date();
  private listener?: (event: SensorEvent) => void;

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.logger.log(
      `Mock sensor "${config.name}" initialised (pin ${String(config.config.pin)})`,
    );
  }

  async destroy(): Promise<void> {
    this.listener = undefined;
    this.config = undefined;
  }

  getState(): SensorReading {
    return { value: this.currentValue, timestamp: this.lastTimestamp };
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  simulateChange(value: 0 | 1): void {
    if (!this.config) return;
    const oldValue = this.currentValue;
    this.currentValue = value;
    this.lastTimestamp = new Date();
    this.listener?.({
      sensorId: this.config.id,
      type: 'state_change',
      oldValue,
      newValue: value,
      timestamp: this.lastTimestamp,
    });
  }
}
