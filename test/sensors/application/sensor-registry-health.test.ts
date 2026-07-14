import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';
import { SensorDriverPort } from '../../../src/sensors/domain/ports/sensor-driver.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';

function sensor(id: string, pin: number): Sensor {
  return {
    id,
    name: id,
    type: 'digital',
    config: { pin },
    enabled: true,
    debounceMs: 0,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

function driver(healthCheck: () => Promise<boolean>): SensorDriverPort {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(),
    onEvent: vi.fn(),
    healthCheck,
  };
}

describe('SensorRegistryService health probes', () => {
  afterEach(() => vi.useRealTimers());

  it('returns one ordered bounded result for every requested health outcome', async () => {
    vi.useFakeTimers();
    const never = new Promise<boolean>(() => undefined);
    const registry = new SensorRegistryService(
      new InMemorySensorRepository([
        sensor('online', 1),
        sensor('offline', 2),
        sensor('failed', 3),
        sensor('timed_out', 4),
      ]),
      vi
        .fn()
        .mockReturnValueOnce(driver(async () => true))
        .mockReturnValueOnce(driver(async () => false))
        .mockReturnValueOnce(driver(async () => { throw new Error('unavailable'); }))
        .mockReturnValueOnce(driver(async () => never)),
    );
    await registry.reload();

    const probe = registry.probe(
      ['timed_out', 'missing', 'online', 'offline', 'failed'],
      5_000,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(probe).resolves.toEqual([
      { sensorId: 'timed_out', status: 'timed_out' },
      { sensorId: 'missing', status: 'missing' },
      { sensorId: 'online', status: 'online' },
      { sensorId: 'offline', status: 'offline' },
      { sensorId: 'failed', status: 'failed' },
    ]);
  });

  it('shares an unresolved driver health check across probes after a waiter times out', async () => {
    vi.useFakeTimers();
    const never = new Promise<boolean>(() => undefined);
    const healthCheck = vi.fn(async () => never);
    const registry = new SensorRegistryService(
      new InMemorySensorRepository([sensor('hanging', 1)]),
      () => driver(healthCheck),
    );
    await registry.reload();

    const first = registry.probe(['hanging'], 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toEqual([{ sensorId: 'hanging', status: 'timed_out' }]);

    const second = registry.probe(['hanging'], 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toEqual([{ sensorId: 'hanging', status: 'timed_out' }]);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });
});
