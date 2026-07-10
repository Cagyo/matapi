import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCo2Source, MockUartCo2Adapter } from '../../../src/sensors/infrastructure/mock-uart-co2.adapter';
import { InMemorySensorLogRepository } from '../../../src/sensors/infrastructure/in-memory-sensor-log.repository';
import { UartConfigInvalidError } from '../../../src/sensors/domain/errors/uart-config-invalid.error';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';
import {
  BaseUartCo2Adapter,
  Co2Source,
  UartCo2Config,
  UartCo2Defaults,
} from '../../../src/sensors/infrastructure/base-uart-co2.adapter';

function uartConfig(over: Partial<SensorConfig['config']> = {}): SensorConfig {
  return {
    id: 'co2_living',
    name: 'CO2 living',
    type: 'uart',
    config: {
      port: '/dev/ttyS0',
      thresholds: { warning: 800, critical: 1200 },
      readIntervalMs: 60_000, // long, so we drive ticks manually via pollOnce
      flushIntervalMs: 600_000,
      ...over,
    },
    debounceMs: 0,
    severity: 'warning',
  };
}

describe('MockUartCo2Adapter (base UART CO2 behaviour)', () => {
  afterEach(() => vi.useRealTimers());

  it('opens the source and primes state on init', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new InMemoryCo2Source([620]);
    const adapter = new MockUartCo2Adapter(logs, source);

    await adapter.init(uartConfig());

    expect(source.isOpen()).toBe(true);
    expect(adapter.getState().value).toBe(0); // no read yet
    await adapter.destroy();
  });

  it('rejects an invalid config (missing port) with UartConfigInvalidError', async () => {
    const adapter = new MockUartCo2Adapter(new InMemorySensorLogRepository(), new InMemoryCo2Source());
    await expect(
      adapter.init({
        ...uartConfig(),
        config: { thresholds: { warning: 800, critical: 1200 } },
      }),
    ).rejects.toThrow(UartConfigInvalidError);
  });

  it('rejects thresholds where critical <= warning', async () => {
    const adapter = new MockUartCo2Adapter(new InMemorySensorLogRepository(), new InMemoryCo2Source());
    await expect(
      adapter.init({
        ...uartConfig(),
        config: { port: '/dev/ttyS0', thresholds: { warning: 1200, critical: 800 } },
      }),
    ).rejects.toThrow(UartConfigInvalidError);
  });

  it('buffers readings and emits a threshold event when crossing a level', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new InMemoryCo2Source([620, 700, 850, 1300]);
    const adapter = new MockUartCo2Adapter(logs, source);
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init(uartConfig());

    await adapter.pollOnce(); // 620 normal
    await adapter.pollOnce(); // 700 normal
    await adapter.pollOnce(); // 850 warning → event
    await adapter.pollOnce(); // 1300 critical → event

    expect(events.map((e) => e.newValue)).toEqual(['warning', 'critical']);
    expect(events.every((e) => e.type === 'threshold')).toBe(true);
    expect(adapter.getState().value).toBe(1300);

    await adapter.flushNow();
    expect(logs.entries.length).toBe(3); // 620 (first), 850 (→warning), 1300 (→critical)
    expect(logs.entries[0]).toMatchObject({ sensorId: 'co2_living', level: 'info' });

    await adapter.destroy();
  });

  it('logs at most one sample per interval in steady state', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new InMemoryCo2Source([620, 640, 660, 680]); // all 'normal'
    const adapter = new MockUartCo2Adapter(logs, source);
    await adapter.init(uartConfig());

    for (let i = 0; i < 4; i += 1) await adapter.pollOnce();
    await adapter.flushNow();

    expect(logs.entries.length).toBe(1); // first sample only; rest throttled
    await adapter.destroy();
  });

  it('discards out-of-range readings without buffering them', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new InMemoryCo2Source([6000, -10, 700]);
    const adapter = new MockUartCo2Adapter(logs, source);
    await adapter.init(uartConfig());

    await adapter.pollOnce(); // 6000 invalid
    await adapter.pollOnce(); // -10 invalid
    await adapter.pollOnce(); // 700 valid
    await adapter.flushNow();

    expect(logs.entries.length).toBe(1);
    expect(logs.entries[0].message).toBe('ppm=700');

    await adapter.destroy();
  });

  it('marks itself degraded after 10 consecutive bad reads', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new InMemoryCo2Source([]);
    const adapter = new MockUartCo2Adapter(logs, source);
    await adapter.init(uartConfig());

    for (let i = 0; i < 10; i += 1) await adapter.pollOnce();

    const raw = adapter.getState().raw as { degraded: boolean };
    expect(raw.degraded).toBe(true);
    expect(source.isOpen()).toBe(true);

    await adapter.destroy();
  });

  it('does not emit when level does not cross', async () => {
    const source = new InMemoryCo2Source([400, 500, 600]);
    const adapter = new MockUartCo2Adapter(new InMemorySensorLogRepository(), source);
    const listener = vi.fn();
    adapter.onEvent(listener);
    await adapter.init(uartConfig());

    await adapter.pollOnce();
    await adapter.pollOnce();
    await adapter.pollOnce();

    expect(listener).not.toHaveBeenCalled();
    await adapter.destroy();
  });

  it('healthCheck returns true when source yields a valid reading', async () => {
    const source = new InMemoryCo2Source([700]);
    const adapter = new MockUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());

    expect(await adapter.healthCheck()).toBe(true);

    await adapter.destroy();
  });

  it('healthCheck reopens a closed source before reading it', async () => {
    const source = new InMemoryCo2Source([700]);
    const adapter = new MockUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());
    await source.close();

    expect(await adapter.healthCheck()).toBe(true);
    expect(source.isOpen()).toBe(true);

    await adapter.destroy();
  });

  it('destroy flushes pending entries', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new InMemoryCo2Source([620]);
    const adapter = new MockUartCo2Adapter(logs, source);
    await adapter.init(uartConfig());

    await adapter.pollOnce();
    await adapter.destroy();

    expect(logs.entries.length).toBe(1);
  });

  it('caps the log buffer so a persistent DB outage cannot grow memory unbounded', async () => {
    const prev = process.env.UART_SAMPLE_LOG_MS;
    process.env.UART_SAMPLE_LOG_MS = '0'; // log every read for this test
    try {
      const logs = new InMemorySensorLogRepository();
      vi.spyOn(logs, 'appendBatch').mockRejectedValue(new Error('db down'));
      const source = new InMemoryCo2Source(
        Array.from({ length: 2000 }, (_, i) => 400 + (i % 50)),
      );
      const adapter = new MockUartCo2Adapter(logs, source);
      await adapter.init(uartConfig({ readIntervalMs: 60_000, flushIntervalMs: 600_000 }));

      for (let i = 0; i < 1500; i += 1) await adapter.pollOnce();
      await adapter.flushNow(); // fails, re-adds, must stay capped

      expect(adapter.pendingLogCount).toBeLessThanOrEqual(500);
      await adapter.destroy();
    } finally {
      if (prev === undefined) delete process.env.UART_SAMPLE_LOG_MS;
      else process.env.UART_SAMPLE_LOG_MS = prev;
    }
  });

  it('reopens after an initial open failure at the first eligible poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const source = new FlakyCo2Source([700]);
    source.queueOpenFailures(1);
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);

    await adapter.init(uartConfig());
    expect(adapter.getState().raw).toMatchObject({ offline: true });
    expect(source.openCalls).toBe(1);

    await adapter.pollOnce();
    expect(source.openCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.pollOnce();
    expect(source.openCalls).toBe(2);
    expect(adapter.getState().raw).toMatchObject({ offline: false });

    await adapter.destroy();
  });

  it('uses the 1s, 2s, 5s, 10s, and 30s reopen eligibility sequence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const source = new FlakyCo2Source();
    source.queueOpenFailures(6);
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);

    await adapter.init(uartConfig());

    let expectedOpenCalls = 1;
    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      await adapter.pollOnce();
      expect(source.openCalls).toBe(expectedOpenCalls);

      await vi.advanceTimersByTimeAsync(1);
      await adapter.pollOnce();
      expectedOpenCalls += 1;
      expect(source.openCalls).toBe(expectedOpenCalls);
    }

    expect(source.openCalls).toBe(6);
    await adapter.destroy();
  });

  it('shares one pending reopen attempt across multiple poll ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const source = new FlakyCo2Source([700]);
    source.queueOpenFailures(1);
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);

    await adapter.init(uartConfig());
    const reopen = source.deferNextOpen();
    await vi.advanceTimersByTimeAsync(1_000);
    const firstTick = adapter.pollOnce();
    await reopen.started;
    const secondTick = adapter.pollOnce();

    expect(source.openCalls).toBe(2);
    reopen.resolve();
    await Promise.all([firstTick, secondTick]);
    expect(source.openCalls).toBe(2);

    await adapter.destroy();
  });

  it('shares an in-flight source read between a poll and health check', async () => {
    const source = new FlakyCo2Source();
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());

    const read = source.deferNextRead();
    const poll = adapter.pollOnce();
    await read.started;
    const health = adapter.healthCheck();

    expect(source.readCalls).toBe(1);
    read.resolve(700);
    await expect(health).resolves.toBe(true);
    await poll;
    expect(source.readCalls).toBe(1);

    await adapter.destroy();
  });

  it('resets recovery after a valid health check instead of retaining a stale 5s delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const source = new FlakyCo2Source(Array.from({ length: 10 }, () => null));
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());

    for (let index = 0; index < 10; index += 1) await adapter.pollOnce();
    expect(adapter.getState().raw).toMatchObject({ degraded: true, offline: false });

    source.queueReadFailures(1);
    await adapter.pollOnce();
    source.queueOpenFailures(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(adapter.healthCheck()).resolves.toBe(false);

    source.queueReadings(700);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(adapter.healthCheck()).resolves.toBe(true);
    expect(adapter.getState().raw).toMatchObject({ degraded: false, offline: false });

    source.queueReadFailures(1);
    await adapter.pollOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.pollOnce();
    expect(source.openCalls).toBe(4);

    await adapter.destroy();
  });

  it('closes, marks offline, and schedules reopen after a read rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const source = new FlakyCo2Source([700]);
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());
    source.queueReadFailures(1);

    await adapter.pollOnce();
    expect(source.closeCalls).toBe(1);
    expect(source.isOpen()).toBe(false);
    expect(adapter.getState().raw).toMatchObject({ offline: true });

    await adapter.pollOnce();
    expect(source.openCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.pollOnce();
    expect(source.openCalls).toBe(2);

    await adapter.destroy();
  });

  it('resets backoff and clears degraded/offline state after a reopened source yields a valid sample', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const source = new FlakyCo2Source(Array.from({ length: 10 }, () => null));
    source.queueOpenFailures(2);
    const adapter = new FlakyUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());

    await vi.advanceTimersByTimeAsync(1_000);
    await adapter.pollOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await adapter.pollOnce();
    for (let index = 0; index < 9; index += 1) await adapter.pollOnce();
    expect(adapter.getState().raw).toMatchObject({ degraded: true, offline: false });

    await source.close();
    source.queueReadings(700);
    await adapter.pollOnce();

    expect(adapter.getState().raw).toMatchObject({ degraded: false, offline: false });
    expect(adapter.getState().value).toBe(700);

    source.queueReadFailures(1);
    await adapter.pollOnce();
    await vi.advanceTimersByTimeAsync(999);
    await adapter.pollOnce();
    expect(source.openCalls).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    await adapter.pollOnce();
    expect(source.openCalls).toBe(5);

    await adapter.destroy();
  });

  it('does not reopen after destroy and flushes the capped buffer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const previousSampleInterval = process.env.UART_SAMPLE_LOG_MS;
    process.env.UART_SAMPLE_LOG_MS = '0';
    try {
      const logs = new InMemorySensorLogRepository();
      const source = new FlakyCo2Source(Array.from({ length: 600 }, () => 700));
      const adapter = new FlakyUartCo2Adapter(logs, source);
      await adapter.init(uartConfig());

      for (let index = 0; index < 600; index += 1) await adapter.pollOnce();
      expect(adapter.pendingLogCount).toBe(500);

      await source.close();
      await adapter.destroy();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(source.openCalls).toBe(1);
      expect(logs.entries).toHaveLength(500);
    } finally {
      if (previousSampleInterval === undefined) delete process.env.UART_SAMPLE_LOG_MS;
      else process.env.UART_SAMPLE_LOG_MS = previousSampleInterval;
    }
  });

  it('ignores a deferred read that resolves after destroy has flushed', async () => {
    const logs = new InMemorySensorLogRepository();
    const source = new FlakyCo2Source();
    const adapter = new FlakyUartCo2Adapter(logs, source);
    await adapter.init(uartConfig());

    const read = source.deferNextRead();
    const tick = adapter.pollOnce();
    await read.started;
    const stateBeforeDestroy = adapter.getState();

    await adapter.destroy();
    read.resolve(1_300);
    await tick;

    expect(adapter.getState()).toEqual(stateBeforeDestroy);
    expect(adapter.pendingLogCount).toBe(0);
    expect(logs.entries).toHaveLength(0);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve,
  };
}

class FlakyCo2Source implements Co2Source {
  private opened = false;
  private openFailures = 0;
  private readFailures = 0;
  private nextOpen?: Deferred<void> & { started: Promise<void>; signalStarted: () => void };
  private nextRead?: Deferred<number | null> & { started: Promise<void>; signalStarted: () => void };
  private readInFlight = false;
  private readonly readings: (number | null)[];

  openCalls = 0;
  closeCalls = 0;
  readCalls = 0;

  constructor(readings: (number | null)[] = []) {
    this.readings = [...readings];
  }

  queueOpenFailures(count: number): void {
    this.openFailures += count;
  }

  queueReadFailures(count: number): void {
    this.readFailures += count;
  }

  queueReadings(...readings: (number | null)[]): void {
    this.readings.push(...readings);
  }

  deferNextOpen(): Deferred<void> & { started: Promise<void> } {
    const attempt = this.createDeferredAttempt<void>();
    this.nextOpen = attempt;
    return attempt;
  }

  deferNextRead(): Deferred<number | null> & { started: Promise<void> } {
    const attempt = this.createDeferredAttempt<number | null>();
    this.nextRead = attempt;
    return attempt;
  }

  async open(_uart: UartCo2Config): Promise<void> {
    this.openCalls += 1;
    if (this.openFailures > 0) {
      this.openFailures -= 1;
      throw new Error('simulated open failure');
    }
    const pendingOpen = this.nextOpen;
    this.nextOpen = undefined;
    if (pendingOpen) {
      pendingOpen.signalStarted();
      await pendingOpen.promise;
    }
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.opened = false;
  }

  isOpen(): boolean {
    return this.opened;
  }

  async read(): Promise<number | null> {
    if (this.readInFlight) throw new Error('concurrent source read');
    this.readCalls += 1;
    this.readInFlight = true;
    try {
      const pendingRead = this.nextRead;
      this.nextRead = undefined;
      if (pendingRead) {
        pendingRead.signalStarted();
        return await pendingRead.promise;
      }
      if (this.readFailures > 0) {
        this.readFailures -= 1;
        throw new Error('simulated read failure');
      }
      return this.readings.shift() ?? null;
    } finally {
      this.readInFlight = false;
    }
  }

  private createDeferredAttempt<T>(): Deferred<T> & {
    started: Promise<void>;
    signalStarted: () => void;
  } {
    const result = deferred<T>();
    const start = deferred<void>();
    return { ...result, started: start.promise, signalStarted: () => start.resolve() };
  }
}

class FlakyUartCo2Adapter extends BaseUartCo2Adapter {
  constructor(logs: InMemorySensorLogRepository, source: FlakyCo2Source) {
    super(source, logs, FlakyUartCo2Adapter.name);
  }

  protected defaults(): UartCo2Defaults {
    return {
      warning: 800,
      critical: 1200,
      readIntervalMs: 60_000,
      flushIntervalMs: 600_000,
      baudRate: 9600,
    };
  }
}
