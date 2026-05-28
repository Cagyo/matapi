import { Injectable, Logger } from '@nestjs/common';
import {
  ISensorDriver,
  SensorConfig,
  SensorEvent,
  SensorReading,
} from '../sensor.interface';
import { PigpioGateway, PigpioGpio, PudMode } from './pigpio.gateway';

interface DigitalConfig {
  pin: number;
  activeLow?: boolean;
  pull?: PudMode;
}

const VALID_PIN_RANGE = { min: 0, max: 27 };

/**
 * Production digital GPIO driver. Connects to pigpiod via PigpioGateway.
 * - Hardware glitch filter (pigpio glitchSet) to reject jitter
 * - JS-level debounce window to suppress repeated triggers within debounceMs
 */
@Injectable()
export class DigitalDriver implements ISensorDriver {
  private readonly logger = new Logger(DigitalDriver.name);
  private config?: SensorConfig;
  private digital?: DigitalConfig;
  private gpio?: PigpioGpio;
  private listener?: (event: SensorEvent) => void;

  /** Last raw level read from the pin (0|1). */
  private rawLevel: 0 | 1 = 0;
  /** Last logical (active-low-mapped) value emitted. */
  private currentValue = false;
  private lastEmittedAt = 0;
  private lastTimestamp = new Date(0);
  private offline = false;

  constructor(private readonly gateway: PigpioGateway) {}

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.digital = this.parseConfig(config.config);

    if (
      this.digital.pin < VALID_PIN_RANGE.min ||
      this.digital.pin > VALID_PIN_RANGE.max
    ) {
      throw new Error(
        `GPIO pin ${this.digital.pin} out of range (${VALID_PIN_RANGE.min}-${VALID_PIN_RANGE.max})`,
      );
    }

    if (!this.gateway.isConnected()) {
      await this.gateway.connect();
    }

    const gpio = this.gateway.gpio(this.digital.pin);
    await gpio.modeSet('input');
    await gpio.pullUpDown(this.pudCode(this.digital.pull ?? 'up'));

    // Hardware glitch filter rejects jitter only. Long debounce stays in JS.
    // Cap hardware filter at 10ms (within pigpio's 0-300000 µs limit).
    const glitchUs = Math.min(10_000, Math.max(0, config.debounceMs * 1000));
    if (glitchUs > 0) {
      await gpio.glitchSet(glitchUs);
    }

    this.rawLevel = await gpio.read();
    this.currentValue = this.mapValue(this.rawLevel);
    this.lastTimestamp = new Date();

    gpio.notify((level) => this.handleNotify(level));

    this.gpio = gpio;
    this.offline = false;
    this.logger.log(
      `Digital "${config.name}" ready on pin ${this.digital.pin} (pull=${this.digital.pull ?? 'up'}, activeLow=${this.digital.activeLow ?? true})`,
    );
  }

  async destroy(): Promise<void> {
    try {
      await this.gpio?.endNotify();
    } catch (err) {
      this.logger.warn(`endNotify failed: ${(err as Error).message}`);
    }
    this.listener = undefined;
    this.gpio = undefined;
  }

  getState(): SensorReading {
    return { value: this.currentValue, timestamp: this.lastTimestamp, raw: this.rawLevel };
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.gpio || this.offline) return false;
    try {
      this.rawLevel = await this.gpio.read();
      return true;
    } catch (err) {
      this.logger.warn(`healthCheck read failed: ${(err as Error).message}`);
      this.offline = true;
      return false;
    }
  }

  /** Extract pin number from raw config. Used by registry for uniqueness checks. */
  static getPin(rawConfig: Record<string, unknown> | null | undefined): number | null {
    const pin = rawConfig?.pin;
    return typeof pin === 'number' ? pin : null;
  }

  private handleNotify(level: 0 | 1): void {
    if (!this.config) return;
    const now = Date.now();
    const debounceMs = this.config.debounceMs ?? 0;

    const oldValue = this.currentValue;
    const newValue = this.mapValue(level);
    this.rawLevel = level;
    this.lastTimestamp = new Date(now);

    if (newValue === oldValue) return;
    if (debounceMs > 0 && now - this.lastEmittedAt < debounceMs) return;

    this.currentValue = newValue;
    this.lastEmittedAt = now;

    this.listener?.({
      sensorId: this.config.id,
      type: 'state_change',
      oldValue,
      newValue,
      timestamp: this.lastTimestamp,
    });
  }

  private mapValue(level: 0 | 1): boolean {
    const activeLow = this.digital?.activeLow ?? true;
    return activeLow ? level === 0 : level === 1;
  }

  private pudCode(pull: PudMode): 0 | 1 | 2 {
    switch (pull) {
      case 'up':
        return 2;
      case 'down':
        return 1;
      case 'none':
        return 0;
    }
  }

  private parseConfig(raw: Record<string, unknown>): DigitalConfig {
    const pin = raw?.pin;
    if (typeof pin !== 'number') {
      throw new Error('Digital sensor config missing required numeric "pin"');
    }
    const pull = raw?.pull;
    if (pull !== undefined && pull !== 'up' && pull !== 'down' && pull !== 'none') {
      throw new Error(`Digital sensor config invalid "pull": ${String(pull)}`);
    }
    return {
      pin,
      activeLow: raw?.activeLow !== undefined ? Boolean(raw.activeLow) : true,
      pull: (pull as PudMode | undefined) ?? 'up',
    };
  }
}
