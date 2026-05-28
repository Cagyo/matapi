import { Logger } from '@nestjs/common';
import { Co2Level, Co2Thresholds, classifyCo2, isValidPpm } from '../domain/co2';
import { UartConfigInvalidError } from '../domain/errors/uart-config-invalid.error';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import {
  SensorLogEntry,
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';

export interface UartCo2Defaults {
  warning: number;
  critical: number;
  readIntervalMs: number;
  flushIntervalMs: number;
  baudRate: number;
}

export interface UartCo2Config {
  port: string;
  baudRate: number;
  thresholds: Co2Thresholds;
  readIntervalMs: number;
  flushIntervalMs: number;
}

const MAX_CONSECUTIVE_BAD_READS = 10;

export function parseUartCo2Config(
  raw: Record<string, unknown>,
  defaults: UartCo2Defaults,
): UartCo2Config {
  const port = raw?.port;
  if (typeof port !== 'string' || port.length === 0) {
    throw new UartConfigInvalidError('missing required string "port"');
  }
  const baudRate = typeof raw?.baudRate === 'number' ? raw.baudRate : defaults.baudRate;
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw new UartConfigInvalidError(`invalid baudRate: ${String(baudRate)}`);
  }
  const rawThresholds = (raw?.thresholds as Partial<Co2Thresholds> | undefined) ?? {};
  const warning =
    typeof rawThresholds.warning === 'number' ? rawThresholds.warning : defaults.warning;
  const critical =
    typeof rawThresholds.critical === 'number' ? rawThresholds.critical : defaults.critical;
  if (warning <= 0 || critical <= 0 || critical <= warning) {
    throw new UartConfigInvalidError(
      `invalid thresholds (warning=${warning}, critical=${critical}); require 0 < warning < critical`,
    );
  }
  const readIntervalMs =
    typeof raw?.readIntervalMs === 'number' ? raw.readIntervalMs : defaults.readIntervalMs;
  const flushIntervalMs =
    typeof raw?.flushIntervalMs === 'number' ? raw.flushIntervalMs : defaults.flushIntervalMs;
  if (readIntervalMs <= 0) {
    throw new UartConfigInvalidError(`invalid readIntervalMs: ${readIntervalMs}`);
  }
  if (flushIntervalMs <= 0) {
    throw new UartConfigInvalidError(`invalid flushIntervalMs: ${flushIntervalMs}`);
  }
  return { port, baudRate, thresholds: { warning, critical }, readIntervalMs, flushIntervalMs };
}

/**
 * Source of PPM readings. The base adapter polls this on `readIntervalMs`.
 * Returns `null` when no sample is available or the read failed.
 */
export interface Co2Source {
  open(uart: UartCo2Config): Promise<void>;
  close(): Promise<void>;
  read(): Promise<number | null>;
  isOpen(): boolean;
}

/**
 * Shared UART CO2 driving logic. Both the real (serialport) and mock adapters
 * subclass `BaseUartCo2Adapter`, providing only a `Co2Source` for sample
 * acquisition. All buffering, thresholding, log-flushing and state management
 * live here.
 */
export abstract class BaseUartCo2Adapter implements SensorDriverPort {
  protected readonly logger: Logger;
  protected config?: SensorConfig;
  protected uart?: UartCo2Config;
  private listener?: (event: SensorEvent) => void;

  private readTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private buffer: SensorLogEntry[] = [];

  private currentPpm: number | null = null;
  private currentLevel: Co2Level = 'normal';
  private lastTimestamp = new Date(0);
  private offline = true;
  private degraded = false;
  private consecutiveBadReads = 0;

  protected constructor(
    protected readonly source: Co2Source,
    protected readonly logs: SensorLogRepositoryPort,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
  }

  protected abstract defaults(): UartCo2Defaults;

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.uart = parseUartCo2Config(config.config, this.defaults());

    try {
      await this.source.open(this.uart);
      this.offline = false;
    } catch (err) {
      this.offline = true;
      this.logger.warn(`UART "${config.name}" open failed: ${(err as Error).message}`);
    }

    this.readTimer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.warn(`tick failed: ${(err as Error).message}`),
      );
    }, this.uart.readIntervalMs);
    this.flushTimer = setInterval(() => {
      void this.flush().catch((err) =>
        this.logger.warn(`flush failed: ${(err as Error).message}`),
      );
    }, this.uart.flushIntervalMs);

    this.logger.log(
      `UART "${config.name}" ready on ${this.uart.port}@${this.uart.baudRate} (warn=${this.uart.thresholds.warning}, crit=${this.uart.thresholds.critical})`,
    );
  }

  async destroy(): Promise<void> {
    if (this.readTimer) clearInterval(this.readTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.readTimer = null;
    this.flushTimer = null;
    try {
      await this.flush();
    } catch (err) {
      this.logger.warn(`flush on destroy failed: ${(err as Error).message}`);
    }
    try {
      await this.source.close();
    } catch (err) {
      this.logger.warn(`source close failed: ${(err as Error).message}`);
    }
    this.listener = undefined;
  }

  getState(): SensorReading {
    return {
      value: this.currentPpm ?? 0,
      timestamp: this.lastTimestamp,
      raw: { level: this.currentLevel, offline: this.offline, degraded: this.degraded },
    };
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.source.isOpen()) return false;
    try {
      const ppm = await this.source.read();
      return isValidPpm(ppm);
    } catch (err) {
      this.logger.warn(`healthCheck read failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Force a read/flush cycle — useful for tests. */
  async pollOnce(): Promise<void> {
    await this.tick();
  }

  async flushNow(): Promise<void> {
    await this.flush();
  }

  private async tick(): Promise<void> {
    if (!this.config || !this.uart) return;
    if (!this.source.isOpen()) return;

    let ppm: number | null;
    try {
      ppm = await this.source.read();
    } catch (err) {
      this.recordBadRead(`read error: ${(err as Error).message}`);
      return;
    }

    if (!isValidPpm(ppm)) {
      this.recordBadRead(`out-of-range: ${String(ppm)}`);
      return;
    }

    this.consecutiveBadReads = 0;
    if (this.degraded) {
      this.degraded = false;
      this.logger.log(`UART "${this.config.name}" recovered from degraded state`);
    }

    const now = new Date();
    this.buffer.push({
      sensorId: this.config.id,
      level: 'info',
      message: `ppm=${ppm}`,
      timestamp: now,
    });

    const previousLevel = this.currentLevel;
    const nextLevel = classifyCo2(ppm, this.uart.thresholds);
    this.currentPpm = ppm;
    this.currentLevel = nextLevel;
    this.lastTimestamp = now;

    if (previousLevel !== nextLevel) {
      this.listener?.({
        sensorId: this.config.id,
        type: 'threshold',
        oldValue: previousLevel,
        newValue: nextLevel,
        timestamp: now,
      });
    }
  }

  private recordBadRead(reason: string): void {
    this.consecutiveBadReads += 1;
    if (this.consecutiveBadReads === MAX_CONSECUTIVE_BAD_READS && !this.degraded) {
      this.degraded = true;
      this.logger.warn(
        `UART "${this.config?.name}" degraded after ${MAX_CONSECUTIVE_BAD_READS} consecutive bad reads (${reason})`,
      );
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.logs.appendBatch(batch);
    } catch (err) {
      // Restore the batch for the next attempt; better partial loss than crash.
      this.buffer = [...batch, ...this.buffer];
      this.logger.warn(`appendBatch failed: ${(err as Error).message}`);
    }
  }
}
