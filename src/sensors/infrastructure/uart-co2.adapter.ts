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
const MAX_RX_BUFFER_BYTES = 64;

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
  readonly isOpen: boolean;
  open(cb?: (err: Error | null | undefined) => void): void;
  write(data: Uint8Array, cb?: (err: Error | null | undefined) => void): boolean;
  close(cb?: (err: Error | null | undefined) => void): void;
  on(event: 'data', cb: (chunk: Buffer) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: 'close', cb: () => void): this;
  removeAllListeners(): this;
}

export type SerialPortFactory = (opts: {
  path: string;
  baudRate: number;
  autoOpen: false;
}) => SerialPortLike;

interface PendingResponse {
  resolve: (ppm: number | null) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Production CO2 source over serialport using the MH-Z19 protocol. The factory
 * indirection lets us defer the `serialport` import until production, keeping
 * dev/unit tests free of the native dependency.
 */
export class SerialPortCo2Source implements Co2Source {
  private port: SerialPortLike | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private pendingResponse: PendingResponse | null = null;

  constructor(private readonly factory: SerialPortFactory) {}

  async open(uart: UartCo2Config): Promise<void> {
    if (this.port) await this.close();
    const port = this.factory({
      path: uart.port,
      baudRate: uart.baudRate,
      autoOpen: false,
    });
    this.listen(port);

    await new Promise<void>((resolve, reject) => {
      try {
        port.open((error) => {
          if (error) {
            port.removeAllListeners();
            this.rxBuffer = Buffer.alloc(0);
            reject(error);
            return;
          }
          this.port = port;
          resolve();
        });
      } catch (error) {
        port.removeAllListeners();
        this.rxBuffer = Buffer.alloc(0);
        reject(asError(error));
      }
    });
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.port = null;
    this.rxBuffer = Buffer.alloc(0);
    this.rejectCurrentPending(new Error('UART port closed'));
    port.removeAllListeners();
    await new Promise<void>((resolve) => {
      try {
        port.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  read(): Promise<number | null> {
    const port = this.port;
    if (!port?.isOpen) return Promise.resolve(null);
    if (this.pendingResponse) return Promise.reject(new Error('UART read already in progress'));

    this.rxBuffer = Buffer.alloc(0);
    return new Promise<number | null>((resolve, reject) => {
      const response: PendingResponse = {
        resolve,
        reject,
        timeout: setTimeout(() => this.resolvePending(response, null), RESPONSE_TIMEOUT_MS),
      };
      this.pendingResponse = response;

      try {
        port.write(MH_Z19_READ_CMD, (error) => {
          if (error) this.rejectResponse(response, error);
        });
      } catch (error) {
        this.rejectResponse(response, asError(error));
      }
    });
  }

  private listen(port: SerialPortLike): void {
    port.on('data', (chunk) => this.onData(port, chunk));
    port.on('error', (error) => this.failPort(port, error));
    port.on('close', () => this.failPort(port, new Error('UART port closed')));
  }

  private onData(port: SerialPortLike, chunk: Buffer): void {
    if (this.port !== port) return;
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    if (!this.pendingResponse) {
      this.rxBuffer = retainCappedSuffix(this.rxBuffer);
      return;
    }

    while (this.pendingResponse) {
      const sofIndex = findFrameStart(this.rxBuffer);
      if (sofIndex === -1) {
        this.rxBuffer =
          this.rxBuffer.at(-1) === 0xff ? Buffer.from(this.rxBuffer.subarray(-1)) : Buffer.alloc(0);
        return;
      }
      if (sofIndex > 0) this.rxBuffer = this.rxBuffer.subarray(sofIndex);
      if (this.rxBuffer.length < 9) {
        this.rxBuffer = retainCappedSuffix(this.rxBuffer);
        return;
      }

      const ppm = parseMhZ19Frame(this.rxBuffer.subarray(0, 9));
      if (ppm === null) {
        this.rxBuffer = this.rxBuffer.subarray(1);
        continue;
      }

      this.rxBuffer = retainCappedSuffix(this.rxBuffer.subarray(9));
      this.resolvePending(this.pendingResponse, ppm);
    }
  }

  private failPort(port: SerialPortLike, error: Error): void {
    if (this.port !== port) return;
    this.port = null;
    this.rxBuffer = Buffer.alloc(0);
    this.rejectCurrentPending(error);
    port.removeAllListeners();
    this.retireErroredPort(port);
  }

  private retireErroredPort(port: SerialPortLike): void {
    if (!port.isOpen) return;
    const removeRetirementListeners = () => port.removeAllListeners();
    port.on('error', () => undefined);
    port.on('close', removeRetirementListeners);
    try {
      port.close((closeError) => {
        if (!closeError || !port.isOpen) removeRetirementListeners();
      });
    } catch {
      removeRetirementListeners();
    }
  }

  private resolvePending(response: PendingResponse, ppm: number | null): void {
    if (this.pendingResponse !== response) return;
    this.pendingResponse = null;
    clearTimeout(response.timeout);
    response.resolve(ppm);
  }

  private rejectCurrentPending(error: Error): void {
    const response = this.pendingResponse;
    if (!response) return;
    this.rejectResponse(response, error);
  }

  private rejectResponse(response: PendingResponse, error: Error): void {
    if (this.pendingResponse !== response) return;
    this.pendingResponse = null;
    clearTimeout(response.timeout);
    response.reject(error);
  }
}

/** Lazy-loads the real `serialport` package only when needed. */
function defaultSerialPortFactory(opts: {
  path: string;
  baudRate: number;
  autoOpen: false;
}): SerialPortLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('serialport') as { SerialPort: new (o: typeof opts) => SerialPortLike };
  return new mod.SerialPort(opts);
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

function findFrameStart(buffer: Buffer): number {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0x86) return index;
  }
  return -1;
}

function retainCappedSuffix(buffer: Buffer): Buffer {
  const suffix =
    buffer.length > MAX_RX_BUFFER_BYTES
      ? buffer.subarray(buffer.length - MAX_RX_BUFFER_BYTES)
      : buffer;
  return Buffer.from(suffix);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
