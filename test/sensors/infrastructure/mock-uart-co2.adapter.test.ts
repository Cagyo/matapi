import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCo2Source, MockUartCo2Adapter } from '../../../src/sensors/infrastructure/mock-uart-co2.adapter';
import { InMemorySensorLogRepository } from '../../../src/sensors/infrastructure/in-memory-sensor-log.repository';
import { UartConfigInvalidError } from '../../../src/sensors/domain/errors/uart-config-invalid.error';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';

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
    source.queueFailures(15);
    const adapter = new MockUartCo2Adapter(logs, source);
    await adapter.init(uartConfig());

    for (let i = 0; i < 10; i += 1) await adapter.pollOnce();

    const raw = adapter.getState().raw as { degraded: boolean };
    expect(raw.degraded).toBe(true);

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

  it('healthCheck returns false when source is closed', async () => {
    const source = new InMemoryCo2Source([700]);
    const adapter = new MockUartCo2Adapter(new InMemorySensorLogRepository(), source);
    await adapter.init(uartConfig());
    await source.close();

    expect(await adapter.healthCheck()).toBe(false);

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
});
