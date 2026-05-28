import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pigpioClientLib = require('pigpio-client');

export type PudMode = 'up' | 'down' | 'none';

/** Subset of the pigpio-client gpio object we use. */
export interface PigpioGpio {
  modeSet(mode: 'input' | 'output'): Promise<void>;
  pullUpDown(pud: 0 | 1 | 2): Promise<void>;
  read(): Promise<0 | 1>;
  glitchSet(steadyUs: number): Promise<void>;
  notify(cb: (level: 0 | 1, tick: number) => void): void;
  endNotify(): Promise<void>;
}

interface PigpioRoot {
  gpio(pin: number): PigpioGpio;
  end(): void;
  on(event: 'connected' | 'disconnected' | 'error', cb: (info?: unknown) => void): void;
  once(event: 'connected' | 'disconnected' | 'error', cb: (info?: unknown) => void): void;
}

/**
 * Singleton wrapper around a pigpio-client connection. All GPIO drivers share
 * one socket to pigpiod. Connection is established lazily and re-used.
 */
@Injectable()
export class PigpioGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PigpioGateway.name);
  private client: PigpioRoot | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    // Best-effort: don't crash app if pigpiod is down on Pi-less dev hosts.
    try {
      await this.connect();
    } catch (err) {
      this.logger.warn(`pigpiod connect failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client && this.connected) {
      try {
        this.client.end();
      } catch {
        /* ignore */
      }
    }
    this.client = null;
    this.connected = false;
    this.connectPromise = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Connect (idempotent). Resolves when the 'connected' event fires. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const host = process.env.PIGPIOD_HOST || 'localhost';
    const port = Number.parseInt(process.env.PIGPIOD_PORT || '8888', 10);

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        const c: PigpioRoot = pigpioClientLib.pigpio({ host, port }) as PigpioRoot;
        this.client = c;

        const onError = (err?: unknown) => {
          this.connected = false;
          this.connectPromise = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        c.once('error', onError);
        c.once('connected', () => {
          this.connected = true;
          this.logger.log(`Connected to pigpiod at ${host}:${port}`);
          c.on('disconnected', () => {
            this.connected = false;
            this.logger.warn('Disconnected from pigpiod');
          });
          c.on('error', (err) => {
            this.logger.warn(`pigpiod error: ${(err as Error)?.message ?? String(err)}`);
          });
          resolve();
        });
      } catch (err) {
        this.connectPromise = null;
        reject(err as Error);
      }
    });

    return this.connectPromise;
  }

  /** Returns a gpio handle. Caller must `await connect()` first. */
  gpio(pin: number): PigpioGpio {
    if (!this.client || !this.connected) {
      throw new Error('pigpiod not connected');
    }
    return this.client.gpio(pin);
  }
}
