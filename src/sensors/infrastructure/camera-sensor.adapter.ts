import { Injectable, Logger } from '@nestjs/common';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';

/** Camera "sensor" — surfaces motion/snapshot events. Stub for Phase 1. */
@Injectable()
export class CameraSensorAdapter implements SensorDriverPort {
  private readonly logger = new Logger(CameraSensorAdapter.name);
  private listener?: (event: SensorEvent) => void;
  private last: SensorReading = { value: 0, timestamp: new Date() };

  async init(config: SensorConfig): Promise<void> {
    this.logger.log(`Camera sensor "${config.name}" init (stub)`);
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
