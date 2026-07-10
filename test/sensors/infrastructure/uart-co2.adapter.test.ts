import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseMhZ19Frame,
  SerialPortCo2Source,
  SerialPortLike,
} from '../../../src/sensors/infrastructure/uart-co2.adapter';

const UART_CONFIG = {
  port: '/dev/ttyAMA0',
  baudRate: 9600,
  thresholds: { warning: 800, critical: 1200 },
  readIntervalMs: 5000,
  flushIntervalMs: 60000,
};

describe('parseMhZ19Frame', () => {
  it('decodes a valid frame to ppm', () => {
    expect(parseMhZ19Frame(buildFrame(0x02, 0x6c))).toBe(620);
  });

  it('rejects a frame with a bad checksum', () => {
    const frame = buildFrame(0x02, 0x6c);
    frame[8] ^= 0xff;
    expect(parseMhZ19Frame(frame)).toBeNull();
  });

  it('rejects a frame of wrong length', () => {
    expect(parseMhZ19Frame(new Uint8Array(8))).toBeNull();
  });

  it('rejects a frame with wrong header bytes', () => {
    const frame = buildFrame(0x02, 0x6c);
    frame[0] = 0xaa;
    expect(parseMhZ19Frame(frame)).toBeNull();
  });
});

describe('SerialPortCo2Source', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves one response frame split across three data chunks', async () => {
    const port = new FakeSerialPort();
    const { source, receivedOptions } = createSource(port);
    await source.open(UART_CONFIG);

    expect(receivedOptions()).toEqual({
      path: '/dev/ttyAMA0',
      baudRate: 9600,
      autoOpen: false,
    });

    const reading = source.read();
    const frame = buildFrame(0x02, 0x6c);
    port.emitData(frame.subarray(0, 2));
    port.emitData(frame.subarray(2, 7));
    port.emitData(frame.subarray(7));

    await expect(reading).resolves.toBe(620);
    await source.close();
  });

  it('scans a response at the start of a chunk larger than the retained suffix', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const reading = source.read();
    port.emitData(Buffer.concat([buildFrame(0x02, 0x6c), Buffer.alloc(128, 0x00)]));

    await expect(reading).resolves.toBe(620);
    await source.close();
  });

  it('skips noise and a bad checksum candidate before the next valid frame', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const badFrame = buildFrame(0x01, 0xf4);
    badFrame[8] ^= 0xff;
    const goodFrame = buildFrame(0x02, 0x58);
    const reading = source.read();
    port.emitData(Buffer.concat([Buffer.from([0x00, 0x7e, 0xff, 0x85]), badFrame, goodFrame]));

    await expect(reading).resolves.toBe(600);
    await source.close();
  });

  it('discards a second same-chunk frame before the next request begins', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const firstFrame = buildFrame(0x01, 0xf4);
    const staleFrame = buildFrame(0x02, 0x58);
    let writeCount = 0;
    port.onWrite = () => {
      writeCount += 1;
      if (writeCount === 1) port.emitData(Buffer.concat([firstFrame, staleFrame]));
    };

    await expect(source.read()).resolves.toBe(500);

    const nextRead = source.read();
    let nextReadSettled = false;
    void nextRead.then(() => {
      nextReadSettled = true;
    });
    await Promise.resolve();
    expect(nextReadSettled).toBe(false);

    port.emitData(buildFrame(0x02, 0xbc));
    await expect(nextRead).resolves.toBe(700);
    await source.close();
  });

  it('resolves null at the response timeout without a polling loop', async () => {
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const reading = source.read();
    expect(timerSpy).toHaveBeenCalledTimes(1);
    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(reading).resolves.toBeNull();
    timerSpy.mockRestore();
    await source.close();
  });

  it('rejects the pending read when the command write fails', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);
    port.writeError = new Error('write failed');

    await expect(source.read()).rejects.toThrow('write failed');
    await source.close();
  });

  it('rejects a failed open without retaining the failed port', async () => {
    const port = new FakeSerialPort();
    port.openError = new Error('open failed');
    const { source } = createSource(port);

    await expect(source.open(UART_CONFIG)).rejects.toThrow('open failed');
    expect(source.isOpen()).toBe(false);
    expect(port.removeAllListenersCalls).toBe(1);
  });

  it('publishes the port only after its manual open callback succeeds', async () => {
    const port = new FakeSerialPort();
    port.deferOpen = true;
    const { source } = createSource(port);

    const opening = source.open(UART_CONFIG);
    expect(source.isOpen()).toBe(false);

    port.completeOpen();
    await opening;
    expect(source.isOpen()).toBe(true);
    await source.close();
  });

  it('rejects a pending read and becomes closed when the port emits an error', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const reading = source.read();
    port.emitError(new Error('connection lost'));

    await expect(reading).rejects.toThrow('connection lost');
    expect(source.isOpen()).toBe(false);
  });

  it('retires an errored open port without letting its late events affect a replacement', async () => {
    const erroredPort = new FakeSerialPort();
    erroredPort.deferClose = true;
    const replacementPort = new FakeSerialPort();
    const source = createSourceFromPorts(erroredPort, replacementPort);
    await source.open(UART_CONFIG);

    const reading = source.read();
    erroredPort.emitError(new Error('connection lost'));

    await expect(reading).rejects.toThrow('connection lost');
    expect(erroredPort.closeCalls).toBe(1);
    expect(erroredPort.isOpen).toBe(true);
    expect(() => erroredPort.emitError(new Error('second error'))).not.toThrow();

    await source.open(UART_CONFIG);
    erroredPort.completeClose();

    expect(source.isOpen()).toBe(true);
    expect(erroredPort.listenerCount).toBe(0);
    await source.close();
  });

  it('rejects a pending read and becomes closed when the port closes', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const reading = source.read();
    port.emitClose();

    await expect(reading).rejects.toThrow('UART port closed');
    expect(source.isOpen()).toBe(false);
  });

  it('uses the serial port isOpen state instead of only tracking an object', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    port.isOpen = false;

    expect(source.isOpen()).toBe(false);
    await source.close();
  });

  it('rejects a second read while another response waiter is pending', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    const firstRead = source.read();
    await expect(source.read()).rejects.toThrow('UART read already in progress');
    port.emitData(buildFrame(0x01, 0xf4));
    await expect(firstRead).resolves.toBe(500);
    await source.close();
  });

  it('removes listeners before explicitly closing the port', async () => {
    const port = new FakeSerialPort();
    const { source } = createSource(port);
    await source.open(UART_CONFIG);

    await source.close();

    expect(port.removeAllListenersCalls).toBe(1);
    expect(port.closeCalls).toBe(1);
    expect(source.isOpen()).toBe(false);
  });
});

function createSource(port: FakeSerialPort): {
  source: SerialPortCo2Source;
  receivedOptions: () => { path: string; baudRate: number; autoOpen: false } | undefined;
} {
  let options: { path: string; baudRate: number; autoOpen: false } | undefined;
  const source = new SerialPortCo2Source((nextOptions) => {
    options = nextOptions;
    return port;
  });
  return { source, receivedOptions: () => options };
}

function createSourceFromPorts(...ports: FakeSerialPort[]): SerialPortCo2Source {
  let portIndex = 0;
  return new SerialPortCo2Source(() => {
    const port = ports[portIndex];
    portIndex += 1;
    if (!port) throw new Error('unexpected serial port factory call');
    return port;
  });
}

class FakeSerialPort implements SerialPortLike {
  isOpen = false;
  deferOpen = false;
  deferWrite = false;
  deferClose = false;
  openError: Error | null = null;
  writeError: Error | null = null;
  onWrite?: (data: Uint8Array) => void;
  removeAllListenersCalls = 0;
  closeCalls = 0;

  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private openCallback?: (err: Error | null | undefined) => void;
  private writeCallback?: (err: Error | null | undefined) => void;
  private closeCallback?: (err: Error | null | undefined) => void;

  get listenerCount(): number {
    return this.dataListeners.size + this.errorListeners.size + this.closeListeners.size;
  }

  open(cb?: (err: Error | null | undefined) => void): void {
    if (this.deferOpen) {
      this.openCallback = cb;
      return;
    }
    if (!this.openError) this.isOpen = true;
    cb?.(this.openError);
  }

  write(data: Uint8Array, cb?: (err: Error | null | undefined) => void): boolean {
    this.onWrite?.(data);
    if (this.deferWrite) {
      this.writeCallback = cb;
      return true;
    }
    cb?.(this.writeError);
    return this.writeError === null;
  }

  close(cb?: (err: Error | null | undefined) => void): void {
    this.closeCalls += 1;
    if (this.deferClose) {
      this.closeCallback = cb;
      return;
    }
    this.isOpen = false;
    for (const listener of this.closeListeners) listener();
    cb?.(null);
  }

  on(event: 'data', cb: (chunk: Buffer) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: 'close', cb: () => void): this;
  on(
    event: 'data' | 'error' | 'close',
    cb: ((chunk: Buffer) => void) | ((err: Error) => void) | (() => void),
  ): this {
    if (event === 'data') this.dataListeners.add(cb as (chunk: Buffer) => void);
    if (event === 'error') this.errorListeners.add(cb as (err: Error) => void);
    if (event === 'close') this.closeListeners.add(cb as () => void);
    return this;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    this.dataListeners.clear();
    this.errorListeners.clear();
    this.closeListeners.clear();
    return this;
  }

  emitData(chunk: Uint8Array): void {
    for (const listener of this.dataListeners) listener(Buffer.from(chunk));
  }

  emitError(error: Error): void {
    if (this.errorListeners.size === 0) throw error;
    for (const listener of this.errorListeners) listener(error);
  }

  emitClose(): void {
    this.isOpen = false;
    for (const listener of this.closeListeners) listener();
  }

  completeOpen(error = this.openError): void {
    if (!error) this.isOpen = true;
    this.openCallback?.(error);
    this.openCallback = undefined;
  }

  completeWrite(error = this.writeError): void {
    this.writeCallback?.(error);
    this.writeCallback = undefined;
  }

  completeClose(error: Error | null = null): void {
    if (!error) {
      this.isOpen = false;
      for (const listener of this.closeListeners) listener();
    }
    this.closeCallback?.(error);
    this.closeCallback = undefined;
  }
}

function buildFrame(high: number, low: number): Uint8Array {
  const frame = new Uint8Array([0xff, 0x86, high, low, 0x00, 0x00, 0x00, 0x00, 0x00]);
  let sum = 0;
  for (let i = 1; i < 8; i += 1) sum += frame[i];
  frame[8] = ((~sum + 1) & 0xff) >>> 0;
  return frame;
}
