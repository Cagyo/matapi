import { Injectable, Logger } from '@nestjs/common';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SimulatableSensorPort } from '../domain/ports/simulatable-sensor.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';

@Injectable()
export class MockMqttAdapter implements SensorDriverPort, SimulatableSensorPort {
  private readonly logger = new Logger(MockMqttAdapter.name);
  private config?: SensorConfig;
  private currentValue: string | number | boolean = 0;
  private lastTimestamp = new Date();
  private listener?: (event: SensorEvent) => void;

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.logger.log(`Mock MQTT sensor "${config.name}" initialized`);
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

  simulateChange(value: string | number | boolean): void {
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

  simulate(value: number): void {
    this.simulateChange(value);
  }
}
