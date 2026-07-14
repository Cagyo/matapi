import { Logger } from '@nestjs/common';
import { Co2Level, Co2Thresholds, classifyCo2, isValidPpm } from '../domain/co2';
import { UartConfigInvalidError } from '../domain/errors/uart-config-invalid.error';
import {
  SensorDriverPort,
  SensorDriverShutdownContext,
} from '../domain/ports/sensor-driver.port';
import {
  SensorLogEntry,
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { completeWithinDriverShutdownContext } from './driver-shutdown';

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
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

const DEFAULT_SAMPLE_LOG_MS = 5 * 60 * 1000;
const MAX_LOG_BUFFER = 500;

function sampleLogIntervalFromEnv(): number {
  const parsed = Number(process.env.UART_SAMPLE_LOG_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SAMPLE_LOG_MS;
}

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
  if (
    !Number.isFinite(warning) ||
    !Number.isFinite(critical) ||
    warning <= 0 ||
    critical <= 0 ||
    critical <= warning
  ) {
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
  private lastSampleLoggedAt = 0;
  private readonly sampleLogIntervalMs = sampleLogIntervalFromEnv();

  private currentPpm: number | null = null;
  private currentLevel: Co2Level = 'normal';
  private lastTimestamp = new Date(0);
  private offline = true;
  private degraded = false;
  private consecutiveBadReads = 0;
  private nextReconnectAt = 0;
  private reconnectDelayIndex = 0;
  private reconnectInFlight: Promise<boolean> | null = null;
  private sourceReadInFlight: Promise<number | null> | null = null;
  private destroyed = false;

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
    this.destroyed = false;
    this.nextReconnectAt = 0;
    this.reconnectDelayIndex = 0;
    this.offline = true;
    await this.ensureOpen();

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

  async destroy(context?: SensorDriverShutdownContext): Promise<void> {
    this.destroyed = true;
    if (this.readTimer) clearInterval(this.readTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.readTimer = null;
    this.flushTimer = null;
    this.listener = undefined;

    const [flushResult, closeResult] = await Promise.all([
      completeWithinDriverShutdownContext(Promise.resolve().then(() => this.flush()), context),
      completeWithinDriverShutdownContext(
        Promise.resolve().then(() => this.source.close()),
        context,
      ),
    ]);
    if (flushResult === 'cancelled') this.logger.warn('UART flush timed out during destroy');
    if (flushResult === 'failed') this.logger.warn('UART flush failed during destroy');
    if (closeResult === 'cancelled') this.logger.warn('UART source close timed out during destroy');
    if (closeResult === 'failed') this.logger.warn('UART source close failed during destroy');
  }

  getState(): SensorReading {
    return {
      value: this.currentPpm ?? 0,
      timestamp: this.lastTimestamp,
      raw: { level: this.currentLevel, offline: this.offline, degraded: this.degraded },
    };
  }

  /** Test/diagnostic accessor for the pending-log buffer depth. */
  get pendingLogCount(): number {
    return this.buffer.length;
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    if (!(await this.ensureOpen()) || this.destroyed) return false;
    try {
      const ppm = await this.readSample();
      if (this.destroyed || !isValidPpm(ppm)) return false;
      this.recordValidSample();
      return true;
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
    if (!this.config || !this.uart || this.destroyed) return;
    if (!(await this.ensureOpen()) || this.destroyed) return;

    let ppm: number | null;
    try {
      ppm = await this.readSample();
    } catch {
      return;
    }
    if (this.destroyed) return;

    if (!isValidPpm(ppm)) {
      this.recordBadRead(`out-of-range: ${String(ppm)}`);
      return;
    }

    this.recordValidSample();

    const now = new Date();
    const previousLevel = this.currentLevel;
    const nextLevel = classifyCo2(ppm, this.uart.thresholds);
    const levelChanged = previousLevel !== nextLevel;
    const dueForSample = now.getTime() - this.lastSampleLoggedAt >= this.sampleLogIntervalMs;

    if (levelChanged || dueForSample) {
      this.lastSampleLoggedAt = now.getTime();
      this.buffer.push({
        sensorId: this.config.id,
        level: 'info',
        message: `ppm=${ppm}`,
        timestamp: now,
      });
      this.capBuffer();
    }

    this.currentPpm = ppm;
    this.currentLevel = nextLevel;
    this.lastTimestamp = now;

    if (levelChanged) {
      this.listener?.({
        sensorId: this.config.id,
        type: 'threshold',
        oldValue: previousLevel,
        newValue: nextLevel,
        timestamp: now,
      });
    }
  }

  private async ensureOpen(): Promise<boolean> {
    if (this.destroyed || !this.uart) return false;
    if (!this.offline && this.source.isOpen()) return true;
    if (Date.now() < this.nextReconnectAt) return false;
    if (this.reconnectInFlight) return this.reconnectInFlight;

    const reconnect = this.openSource();
    this.reconnectInFlight = reconnect;
    return reconnect;
  }

  private async openSource(): Promise<boolean> {
    try {
      await this.source.open(this.uart!);
      if (this.destroyed) {
        await this.closeSourceBestEffort('source close after destroy failed');
        return false;
      }
      this.offline = false;
      return true;
    } catch (err) {
      if (!this.destroyed) {
        this.offline = true;
        this.scheduleReconnect();
        this.logger.warn(`UART "${this.config?.name}" open failed: ${(err as Error).message}`);
      }
      return false;
    } finally {
      this.reconnectInFlight = null;
    }
  }

  private readSample(): Promise<number | null> {
    if (this.sourceReadInFlight) return this.sourceReadInFlight;

    const read = Promise.resolve()
      .then(() => this.source.read())
      .catch(async (err) => {
        await this.handleReadFailure(err);
        throw err;
      })
      .finally(() => {
        if (this.sourceReadInFlight === read) this.sourceReadInFlight = null;
      });
    this.sourceReadInFlight = read;
    return read;
  }

  private async handleReadFailure(err: unknown): Promise<void> {
    await this.closeSourceBestEffort('source close after read failure failed');
    if (this.destroyed) return;
    this.offline = true;
    this.scheduleReconnect();
    this.recordBadRead(`read error: ${(err as Error).message}`);
  }

  private recordValidSample(): void {
    this.consecutiveBadReads = 0;
    this.nextReconnectAt = 0;
    this.reconnectDelayIndex = 0;
    this.offline = false;
    if (this.degraded) {
      this.degraded = false;
      this.logger.log(`UART "${this.config?.name}" recovered from degraded state`);
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = RECONNECT_DELAYS_MS[this.reconnectDelayIndex];
    this.nextReconnectAt = Date.now() + delay;
    this.reconnectDelayIndex = Math.min(
      this.reconnectDelayIndex + 1,
      RECONNECT_DELAYS_MS.length - 1,
    );
  }

  private async closeSourceBestEffort(context: string): Promise<void> {
    try {
      await this.source.close();
    } catch (err) {
      this.logger.warn(`${context}: ${(err as Error).message}`);
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

  private capBuffer(): void {
    if (this.buffer.length > MAX_LOG_BUFFER) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_LOG_BUFFER);
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.logs.appendBatch(batch);
    } catch (err) {
      if (this.destroyed) return;
      // Restore the batch for the next attempt, capped so a persistent DB
      // outage cannot grow memory without bound.
      this.buffer = [...batch, ...this.buffer];
      this.capBuffer();
      this.logger.warn(`appendBatch failed: ${(err as Error).message}`);
    }
  }
}
