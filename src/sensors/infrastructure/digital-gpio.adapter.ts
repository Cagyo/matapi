import { Injectable, Logger } from '@nestjs/common';
import { GpioPin } from '../domain/gpio-pin.value-object';
import { DigitalConfigInvalidError } from '../domain/errors/digital-config-invalid.error';
import { DriverUnavailableError } from '../domain/errors/driver-unavailable.error';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { DigitalStepType, isDigitalStepType, SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { PigpioGateway, PigpioGpio, PudMode } from './pigpio.gateway';

interface DigitalConfig {
  pin: GpioPin;
  activeLow: boolean;
  invert: boolean;
  pull: PudMode;
  stepType: DigitalStepType;
}

/**
 * Production digital GPIO adapter. Connects to pigpiod via PigpioGateway.
 * - Hardware glitch filter (pigpio glitchSet) to reject jitter (≤10 ms).
 * - Auto-inferred debouncing strategies based on stepType (Symmetric, Asymmetric Alarm, Asymmetric Cooldown).
 * - Anti-flapping hardware circuit breaker (>30 transitions/min switches to 10s Polled Sampling Mode).
 * - Strict timer lifecycle cleanup to prevent memory leaks in PM2 workers.
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

  private activeTimers = new Set<NodeJS.Timeout>();
  private transitionTimestamps: number[] = [];
  private isFlapping = false;
  private polledInterval?: NodeJS.Timeout;

  constructor(private readonly gateway: PigpioGateway) {}

  async init(config: SensorConfig): Promise<void> {
    this.clearActiveTimers();
    if (this.polledInterval) {
      clearInterval(this.polledInterval);
      this.polledInterval = undefined;
    }
    this.transitionTimestamps = [];
    this.isFlapping = false;

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
      `Digital "${config.name}" ready on pin ${this.digital.pin.value} (stepType=${this.digital.stepType}, pull=${this.digital.pull}, invert=${this.digital.invert})`,
    );
  }

  async destroy(): Promise<void> {
    this.clearActiveTimers();
    if (this.polledInterval) {
      clearInterval(this.polledInterval);
      this.polledInterval = undefined;
    }
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
    if (!this.config || !this.digital) return;
    const now = Date.now();

    // Circuit Breaker / Anti-Flapping check (60s sliding window)
    this.transitionTimestamps.push(now);
    while (this.transitionTimestamps.length > 0 && now - this.transitionTimestamps[0] > 60_000) {
      this.transitionTimestamps.shift();
    }
    if (this.transitionTimestamps.length > 30 && !this.isFlapping) {
      this.logger.warn(
        `Sensor "${this.config.name}" (pin ${this.digital.pin.value}) flapping! Switching to 10s polled sampling mode.`,
      );
      this.isFlapping = true;
      this.startPolledSampling();
      return;
    }
    if (this.isFlapping) return;

    this.processLevelChange(level, now);
  }

  private startPolledSampling(): void {
    if (this.polledInterval) clearInterval(this.polledInterval);
    this.gpio?.endNotify().catch((err) => {
      this.logger.warn(`endNotify during flapping failed: ${(err as Error).message}`);
    });

    this.polledInterval = setInterval(() => {
      void (async () => {
        if (!this.gpio || !this.config || !this.digital) return;
        try {
          const level = await this.gpio.read();
          this.processLevelChange(level, Date.now());
        } catch (err) {
          this.logger.warn(`Polled read failed: ${(err as Error).message}`);
          this.offline = true;
        }
      })();
    }, 10_000);
  }

  private processLevelChange(level: 0 | 1, now: number): void {
    if (!this.config || !this.digital) return;
    this.rawLevel = level;
    this.lastTimestamp = new Date(now);

    const candidateValue = this.mapValue(level);
    if (candidateValue === this.currentValue) {
      this.clearActiveTimers();
      return;
    }

    const debounceMs = this.config.debounceMs ?? 0;
    const delay = this.getDebounceDelay(this.digital.stepType, !this.currentValue && candidateValue, debounceMs);

    if (delay === 0) {
      this.clearActiveTimers();
      this.commitValueChange(candidateValue, now);
    } else {
      this.clearActiveTimers();
      const timer = setTimeout(() => {
        this.activeTimers.delete(timer);
        if (this.mapValue(this.rawLevel) === candidateValue) {
          this.commitValueChange(candidateValue, Date.now());
        }
      }, delay);
      this.activeTimers.add(timer);
    }
  }

  private getDebounceDelay(stepType: DigitalStepType, isRising: boolean, configDebounceMs: number): number {
    switch (stepType) {
      case 'leak_hazard':
      case 'alarm':
        return isRising ? Math.min(configDebounceMs, 50) : Math.max(configDebounceMs, 60_000);
      case 'motion':
        return isRising ? 0 : Math.max(configDebounceMs, 5_000);
      case 'button':
        return isRising ? 0 : Math.max(configDebounceMs, 3_000);
      case 'power':
      case 'contact':
      default:
        return configDebounceMs;
    }
  }

  private commitValueChange(newValue: boolean, now: number): void {
    if (this.currentValue === newValue) return;
    const oldValue = this.currentValue;
    this.currentValue = newValue;
    this.lastEmittedAt = now;
    this.lastTimestamp = new Date(now);

    if (!this.config) return;
    this.listener?.({
      sensorId: this.config.id,
      type: 'state_change',
      oldValue,
      newValue,
      timestamp: this.lastTimestamp,
    });
  }

  private clearActiveTimers(): void {
    this.activeTimers.forEach((timer) => clearTimeout(timer));
    this.activeTimers.clear();
  }

  private mapValue(level: 0 | 1): boolean {
    return this.digital?.invert ? level === 0 : level === 1;
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
      throw new DigitalConfigInvalidError(`invalid "pull": ${JSON.stringify(pull)}`);
    }

    const stepTypeRaw = raw?.stepType;
    const stepType: DigitalStepType = isDigitalStepType(stepTypeRaw) ? stepTypeRaw : 'contact';

    const activeLow = raw?.activeLow !== undefined ? Boolean(raw.activeLow) : true;
    const invert = raw?.invert !== undefined ? Boolean(raw.invert) : activeLow;

    return {
      pin,
      activeLow,
      invert,
      pull: pull ?? 'up',
      stepType,
    };
  }
}
