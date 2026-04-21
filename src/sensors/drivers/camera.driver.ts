import { Injectable, Logger } from '@nestjs/common';
import {
  ISensorDriver,
  SensorConfig,
  SensorEvent,
  SensorReading,
} from '../sensor.interface';

/** Camera "sensor" — surfaces motion/snapshot events. Stub for Phase 1. */
@Injectable()
export class CameraDriver implements ISensorDriver {
  private readonly logger = new Logger(CameraDriver.name);
  private config?: SensorConfig;
  private listener?: (event: SensorEvent) => void;
  private last: SensorReading = { value: 0, timestamp: new Date() };

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.logger.log(`Camera sensor "${config.name}" init`);
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
