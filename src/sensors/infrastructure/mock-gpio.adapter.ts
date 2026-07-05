import { Injectable, Logger } from '@nestjs/common';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorLogRepositoryPort } from '../domain/ports/sensor-log-repository.port';
import { SimulatableSensorPort } from '../domain/ports/simulatable-sensor.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { en } from '../../locales/en';

/**
 * Mock GPIO adapter for development. State changes are triggered manually via
 * `simulateChange()` (e.g. from the dev simulator HTTP panel, spec 26).
 */
@Injectable()
export class MockGpioAdapter implements SensorDriverPort, SimulatableSensorPort {
  private readonly logger = new Logger(MockGpioAdapter.name);
  private config?: SensorConfig;
  private currentValue: 0 | 1 = 0;
  private lastTimestamp = new Date();
  private listener?: (event: SensorEvent) => void;

  constructor(private readonly logs?: SensorLogRepositoryPort) {}

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
    const stepType = (this.config.config?.stepType as string) || 'contact';
    const oldVal = oldValue === 1;
    const newVal = value === 1;
    void this.logs?.appendBatch([
      {
        sensorId: this.config.id,
        level: 'info',
        message: en.logs.stateChange(stepType, oldVal, newVal),
        timestamp: this.lastTimestamp,
      },
    ]);
    this.listener?.({
      sensorId: this.config.id,
      type: 'state_change',
      oldValue,
      newValue: value,
      timestamp: this.lastTimestamp,
    });
  }

  /** `SimulatableSensorPort` — any non-zero value is treated as HIGH. */
  simulate(value: number): void {
    this.simulateChange(value >= 1 ? 1 : 0);
  }
}
