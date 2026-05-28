import { Injectable, Logger } from '@nestjs/common';
import { GpioPin } from '../domain/gpio-pin.value-object';
import { DigitalConfigInvalidError } from '../domain/errors/digital-config-invalid.error';
import { DriverUnavailableError } from '../domain/errors/driver-unavailable.error';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { PigpioGateway, PigpioGpio, PudMode } from './pigpio.gateway';

interface DigitalConfig {
  pin: GpioPin;
  activeLow: boolean;
  pull: PudMode;
}

/**
 * Production digital GPIO adapter. Connects to pigpiod via PigpioGateway.
 * - Hardware glitch filter (pigpio glitchSet) to reject jitter (≤10 ms).
 * - JS-level debounce window suppresses repeated triggers within debounceMs.
 */
@Injectable()
export class DigitalGpioAdapter implements SensorDriverPort {
  private readonly logger = new Logger(DigitalGpioAdapter.name);
  private config?: SensorConfig;
  private digital?: DigitalConfig;
  private gpio?: PigpioGpio;
  private listener?: (event: SensorEvent) => void;

  private rawLevel: 0 | 1 = 0;
  private currentValue = false;
  private lastEmittedAt = 0;
  private lastTimestamp = new Date(0);
  private offline = false;

  constructor(private readonly gateway: PigpioGateway) {}

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.digital = this.parseConfig(config.config);

    if (!this.gateway.isConnected()) {
      try {
        await this.gateway.connect();
      } catch (err) {
        throw new DriverUnavailableError('pigpiod', (err as Error).message);
      }
    }

    const gpio = this.gateway.gpio(this.digital.pin.value);
    await gpio.modeSet('input');
    await gpio.pullUpDown(this.pudCode(this.digital.pull));

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
      `Digital "${config.name}" ready on pin ${this.digital.pin} (pull=${this.digital.pull}, activeLow=${this.digital.activeLow})`,
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
    return {
      value: this.currentValue,
      timestamp: this.lastTimestamp,
      raw: this.rawLevel,
    };
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

  /** Extract pin number from raw config. Used by application layer for uniqueness checks. */
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
    return this.digital?.activeLow ? level === 0 : level === 1;
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
    const pinValue = raw?.pin;
    if (typeof pinValue !== 'number') {
      throw new DigitalConfigInvalidError('missing required numeric "pin"');
    }
    const pin = new GpioPin(pinValue);

    const pull = raw?.pull;
    if (pull !== undefined && pull !== 'up' && pull !== 'down' && pull !== 'none') {
      throw new DigitalConfigInvalidError(`invalid "pull": ${String(pull)}`);
    }
    return {
      pin,
      activeLow: raw?.activeLow !== undefined ? Boolean(raw.activeLow) : true,
      pull: (pull as PudMode | undefined) ?? 'up',
    };
  }
}
