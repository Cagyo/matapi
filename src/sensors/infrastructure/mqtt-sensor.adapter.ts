import { Injectable, Logger } from '@nestjs/common';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';

/** MQTT-backed sensor adapter. Stub for Phase 2 (Zigbee/MQTT). */
@Injectable()
export class MqttSensorAdapter implements SensorDriverPort {
  private readonly logger = new Logger(MqttSensorAdapter.name);
  private listener?: (event: SensorEvent) => void;
  private last: SensorReading = { value: 0, timestamp: new Date() };

  async init(config: SensorConfig): Promise<void> {
    this.logger.log(`MQTT sensor "${config.name}" init (stub)`);
  }

  async destroy(): Promise<void> {
    this.listener = undefined;
  }

  getState(): SensorReading {
    return this.last;
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}
