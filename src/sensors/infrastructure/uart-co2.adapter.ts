import { Injectable } from '@nestjs/common';
import {
  BaseUartCo2Adapter,
  Co2Source,
  UartCo2Config,
  UartCo2Defaults,
} from './base-uart-co2.adapter';
import {
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';

const MH_Z19_READ_CMD = Uint8Array.from([
  0xff, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79,
]);
const RESPONSE_TIMEOUT_MS = 1000;

/**
 * Parse a 9-byte MH-Z19 CO2 response frame.
 * Returns ppm if the frame is valid, otherwise `null`.
 *
 *   bytes:  0xFF 0x86 [high] [low] ... [checksum]
 *   ppm  =  high * 256 + low
 *   chk  =  (~sum(bytes[1..7]) + 1) & 0xFF
 */
export function parseMhZ19Frame(frame: Uint8Array): number | null {
  if (frame.length !== 9) return null;
  if (frame[0] !== 0xff || frame[1] !== 0x86) return null;

  let sum = 0;
  for (let i = 1; i < 8; i += 1) sum += frame[i];
  const checksum = ((~sum + 1) & 0xff) >>> 0;
  if (checksum !== frame[8]) return null;

  return frame[2] * 256 + frame[3];
}

/**
 * Minimal serialport interface — keeps the adapter testable without pulling
 * `serialport` types into the rest of the codebase.
 */
export interface SerialPortLike {
  write(data: Uint8Array, cb?: (err: Error | null | undefined) => void): boolean;
  close(cb?: (err: Error | null | undefined) => void): void;
  on(event: 'data', cb: (chunk: Buffer) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  removeAllListeners(): this;
}

export type SerialPortFactory = (opts: { path: string; baudRate: number }) => Promise<SerialPortLike>;

/**
 * Production CO2 source over serialport using the MH-Z19 protocol. The factory
 * indirection lets us defer the `serialport` import until production, keeping
 * dev/unit tests free of the native dependency.
 */
class SerialPortCo2Source implements Co2Source {
  private port: SerialPortLike | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);

  constructor(private readonly factory: SerialPortFactory) {}

  async open(uart: UartCo2Config): Promise<void> {
    const port = await this.factory({ path: uart.port, baudRate: uart.baudRate });
    port.on('data', (chunk) => {
      this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
      if (this.rxBuffer.length > 64) {
        this.rxBuffer = this.rxBuffer.subarray(this.rxBuffer.length - 64);
      }
    });
    port.on('error', () => {
      // surfaced via next read() failure
    });
    this.port = port;
  }

  async close(): Promise<void> {
    const port = this.port;
    this.port = null;
    if (!port) return;
    await new Promise<void>((resolve) => {
      port.removeAllListeners();
      port.close((err) => {
        // close errors are non-fatal; the parent logs them
        if (err) resolve();
        else resolve();
      });
    });
  }

  isOpen(): boolean {
    return this.port !== null;
  }

  async read(): Promise<number | null> {
    if (!this.port) return null;
    this.rxBuffer = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      this.port?.write(MH_Z19_READ_CMD, (err) => (err ? reject(err) : resolve()));
    });
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (this.rxBuffer.length < 9 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    if (this.rxBuffer.length < 9) return null;
    const frame = this.rxBuffer.subarray(0, 9);
    this.rxBuffer = this.rxBuffer.subarray(9);
    return parseMhZ19Frame(frame);
  }
}

/** Lazy-loads the real `serialport` package only when needed. */
async function defaultSerialPortFactory(opts: {
  path: string;
  baudRate: number;
}): Promise<SerialPortLike> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('serialport') as { SerialPort: new (o: { path: string; baudRate: number }) => SerialPortLike };
  return new mod.SerialPort({ path: opts.path, baudRate: opts.baudRate });
}

@Injectable()
export class UartCo2Adapter extends BaseUartCo2Adapter {
  constructor(
    logs: SensorLogRepositoryPort,
    factory: SerialPortFactory = defaultSerialPortFactory,
  ) {
    super(new SerialPortCo2Source(factory), logs, UartCo2Adapter.name);
  }

  protected defaults(): UartCo2Defaults {
    return {
      warning: positiveIntFromEnv(process.env.CO2_WARNING_PPM, 800),
      critical: positiveIntFromEnv(process.env.CO2_CRITICAL_PPM, 1200),
      readIntervalMs: positiveIntFromEnv(process.env.CO2_READ_INTERVAL_MS, 5000),
      flushIntervalMs: positiveIntFromEnv(process.env.CO2_FLUSH_INTERVAL_MS, 60000),
      baudRate: 9600,
    };
  }
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
