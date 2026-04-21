import { Injectable, Logger } from '@nestjs/common';
import {
  ISensorDriver,
  SensorConfig,
  SensorEvent,
  SensorReading,
} from '../sensor.interface';

/**
 * Production digital GPIO driver. Connects to pigpiod via socket.
 * Stub: full pigpio-client wiring is implemented in subsequent phases.
 */
@Injectable()
export class DigitalDriver implements ISensorDriver {
  private readonly logger = new Logger(DigitalDriver.name);
  private config?: SensorConfig;
  private current: 0 | 1 = 0;
  private lastTimestamp = new Date();
  private listener?: (event: SensorEvent) => void;

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.logger.log(`Digital sensor "${config.name}" init on pin ${config.config.pin}`);
    // TODO: connect to pigpiod, configure pull, attach interrupt
  }

  async destroy(): Promise<void> {
    // TODO: detach interrupt, close socket
    this.listener = undefined;
  }

  getState(): SensorReading {
    return { value: this.current, timestamp: this.lastTimestamp };
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    // TODO: verify pigpiod socket is reachable
    return false;
  }
}
