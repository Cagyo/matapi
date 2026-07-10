import { Injectable, Logger } from '@nestjs/common';
import { GpioPin } from '../domain/gpio-pin.value-object';
import { DigitalConfigInvalidError } from '../domain/errors/digital-config-invalid.error';
import { DriverUnavailableError } from '../domain/errors/driver-unavailable.error';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorLogRepositoryPort } from '../domain/ports/sensor-log-repository.port';
import { DigitalStepType, isDigitalStepType, SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { en } from '../../locales/en';
import {
  PigpioConnectionState,
  PigpioGateway,
  PigpioGpio,
  PudMode,
} from './pigpio.gateway';

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
  private gatewayUnsubscribe?: () => void;
  private restoredGeneration = 0;
  private requestedGeneration = 0;
  private connectedGeneration = 0;
  private bindPromise: Promise<void> = Promise.resolve();
  private destroyed = false;

  private rawLevel: 0 | 1 = 0;
  private currentValue = false;
  private lastEmittedAt = 0;
  private lastTimestamp = new Date(0);
  private offline = false;

  private activeTimers = new Set<NodeJS.Timeout>();
  private transitionTimestamps: number[] = [];
  private isFlapping = false;
  private debounceLogged = false;
  private polledInterval?: NodeJS.Timeout;
  private polledSince = 0;
  private static readonly FLAP_RECOVERY_MS = 5 * 60 * 1000;

  constructor(
    private readonly gateway: PigpioGateway,
    private readonly logs?: SensorLogRepositoryPort,
  ) {}

  async init(config: SensorConfig): Promise<void> {
    this.clearActiveTimers();
    if (this.polledInterval) {
      clearInterval(this.polledInterval);
      this.polledInterval = undefined;
    }
    this.transitionTimestamps = [];
    this.isFlapping = false;
    this.debounceLogged = false;
    this.destroyed = false;
    this.restoredGeneration = 0;
    this.requestedGeneration = 0;
    this.connectedGeneration = 0;
    this.bindPromise = Promise.resolve();

    this.config = config;
    this.digital = this.parseConfig(config.config);

    // Subscribe before the first connect attempt so an unavailable pigpiod at
    // startup can later restore this configured driver without a registry reload.
    this.gatewayUnsubscribe = this.gateway.onConnectionState((state) => {
      this.handleConnectionState(state);
    });

    if (this.gateway.isConnected()) {
      this.handleConnectionState(this.gateway.connectionState());
      await this.bindPromise;
    } else {
      try {
        await this.gateway.connect();
      } catch (err) {
        this.offline = true;
        if (err instanceof DriverUnavailableError) throw err;
        throw new DriverUnavailableError('pigpiod', (err as Error).message);
      }
      // `connect()` publishes a connected state synchronously before resolving.
      // Await the binding it queued so a successful init has a configured handle.
      await this.bindPromise;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.gatewayUnsubscribe?.();
    this.gatewayUnsubscribe = undefined;
    await this.bindPromise;
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

  private handleConnectionState(state: PigpioConnectionState): void {
    if (this.destroyed || !this.config || !this.digital) return;
    if (!state.connected) {
      this.offline = true;
      this.connectedGeneration = 0;
      this.clearActiveTimers();
      return;
    }
    this.connectedGeneration = state.generation;
    this.queueBind(state.generation);
  }

  private queueBind(generation: number): void {
    if (
      this.destroyed ||
      generation <= this.restoredGeneration ||
      generation <= this.requestedGeneration
    ) {
      return;
    }
    this.requestedGeneration = generation;
    this.bindPromise = this.bindPromise.then(async () => {
      if (this.destroyed || generation <= this.restoredGeneration) return;
      try {
        await this.bindGpio(generation);
      } catch (err) {
        this.offline = true;
        this.logger.warn(
          `Digital "${this.config?.name}" failed to bind after pigpiod connection: ${(err as Error).message}`,
        );
      }
    });
  }

  private async bindGpio(generation: number): Promise<void> {
    if (!this.config || !this.digital || this.destroyed) return;

    const previousGpio = this.gpio;
    if (previousGpio) {
      try {
        await previousGpio.endNotify();
      } catch (err) {
        this.logger.warn(`endNotify before GPIO rebind failed: ${(err as Error).message}`);
      }
    }
    this.gpio = undefined;

    const gpio = this.gateway.gpio(this.digital.pin.value);
    await gpio.modeSet('input');
    if (this.destroyed) return;
    await gpio.pullUpDown(this.pudCode(this.digital.pull));
    if (this.destroyed) return;

    // Hardware glitch filter rejects jitter only. Long debounce stays in JS.
    // Cap hardware filter at 10ms (within pigpio's 0-300000 µs limit).
    const glitchUs = Math.min(10_000, Math.max(0, this.config.debounceMs * 1000));
    await gpio.glitchSet(glitchUs);
    if (this.destroyed) return;

    const level = await gpio.read();
    if (this.destroyed || generation !== this.connectedGeneration) return;

    const isInitialBinding = this.restoredGeneration === 0;
    this.gpio = gpio;
    this.restoredGeneration = generation;
    this.offline = false;
    if (isInitialBinding) {
      this.rawLevel = level;
      this.currentValue = this.mapValue(level);
      this.lastTimestamp = new Date();
    } else {
      this.processLevelChange(level, Date.now());
    }

    if (!this.isFlapping) {
      gpio.notify((notifyLevel) => this.handleNotify(generation, notifyLevel));
    }

    this.logger.log(
      `Digital "${this.config.name}" ready on pin ${this.digital.pin.value} (stepType=${this.digital.stepType}, pull=${this.digital.pull}, invert=${this.digital.invert})`,
    );
  }

  private handleNotify(generation: number, level: 0 | 1): void {
    if (
      this.destroyed ||
      this.offline ||
      generation !== this.restoredGeneration ||
      generation !== this.connectedGeneration
    ) {
      return;
    }
    if (!this.config || !this.digital) return;
    const now = Date.now();

    // Circuit Breaker / Anti-Flapping check (60s sliding window)
    this.transitionTimestamps.push(now);
    while (this.transitionTimestamps.length > 0 && now - this.transitionTimestamps[0] > 60_000) {
      this.transitionTimestamps.shift();
    }
    if (this.transitionTimestamps.length > 30 && !this.isFlapping) {
      const msg = en.logs.flappingFault(this.config.name, this.digital.pin.value);
      this.logger.warn(msg);
      void this.logs?.appendBatch([
        {
          sensorId: this.config.id,
          level: 'warn',
          message: msg,
          timestamp: new Date(now),
        },
      ]);
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

    this.polledSince = Date.now();
    this.polledInterval = setInterval(() => {
      void (async () => {
        if (this.offline || !this.gpio || !this.config || !this.digital) return;
        if (Date.now() - this.polledSince >= DigitalGpioAdapter.FLAP_RECOVERY_MS) {
          this.resumeFromFlapping();
          return;
        }
        try {
          const level = await this.gpio.read();
          if (this.destroyed || this.offline) return;
          this.processLevelChange(level, Date.now());
        } catch (err) {
          this.logger.warn(`Polled read failed: ${(err as Error).message}`);
          this.offline = true;
        }
      })();
    }, 10_000);
  }

  /** After the cooldown, drop back to hardware notifications; re-trips if still noisy. */
  private resumeFromFlapping(): void {
    if (this.polledInterval) {
      clearInterval(this.polledInterval);
      this.polledInterval = undefined;
    }
    this.isFlapping = false;
    this.transitionTimestamps = [];
    this.debounceLogged = false;
    if (!this.gpio || this.offline || this.destroyed) return;
    const generation = this.restoredGeneration;
    this.gpio.notify((level) => this.handleNotify(generation, level));
    this.logger.log(
      `Digital "${this.config?.name}" resumed hardware notifications after flap cooldown`,
    );
  }

  private processLevelChange(level: 0 | 1, now: number): void {
    if (!this.config || !this.digital) return;
    this.rawLevel = level;
    this.lastTimestamp = new Date(now);

    if (this.activeTimers.size > 0 && !this.debounceLogged) {
      this.debounceLogged = true;
      const recentCount = Math.max(
        2,
        this.transitionTimestamps.filter((t) => now - t <= 1000).length,
      );
      void this.logs?.appendBatch([
        {
          sensorId: this.config.id,
          level: 'warn',
          message: en.logs.debounceTriggered(recentCount, 1),
          timestamp: new Date(now),
        },
      ]);
    }

    const candidateValue = this.mapValue(level);
    if (candidateValue === this.currentValue) {
      this.clearActiveTimers();
      return;
    }

    const debounceMs = this.config.debounceMs ?? 0;
    const delay = this.getDebounceDelay(this.digital.stepType, !this.currentValue && candidateValue, debounceMs);

    if (delay === 0) {
      this.clearActiveTimers();
      this.debounceLogged = false;
      this.commitValueChange(candidateValue, now);
    } else {
      this.clearActiveTimers();
      const timer = setTimeout(() => {
        this.activeTimers.delete(timer);
        if (this.mapValue(this.rawLevel) === candidateValue) {
          this.debounceLogged = false;
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
    const stepType = (this.digital?.stepType as string) || 'contact';
    void this.logs?.appendBatch([
      {
        sensorId: this.config.id,
        level: 'info',
        message: en.logs.stateChange(stepType, oldValue, newValue),
        timestamp: this.lastTimestamp,
      },
    ]);

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
