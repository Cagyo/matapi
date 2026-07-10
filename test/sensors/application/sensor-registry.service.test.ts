import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { SensorDriverPort } from '../../../src/sensors/domain/ports/sensor-driver.port';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';
import { MockGpioAdapter } from '../../../src/sensors/infrastructure/mock-gpio.adapter';
import { DriverUnavailableError } from '../../../src/sensors/domain/errors/driver-unavailable.error';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';

function digitalSensor(over: Partial<Sensor> = {}): Sensor {
  return {
    id: 'front_door',
    name: 'Front door',
    type: 'digital',
    config: { pin: 17 },
    enabled: true,
    debounceMs: 100,
    severity: 'warning',
    lastValue: null,
    lastValueAt: null,
    ...over,
  };
}

function makeRegistry(repo: InMemorySensorRepository, factory: (type: string) => SensorDriverPort) {
  return new SensorRegistryService(repo, factory);
}

describe('SensorRegistryService', () => {
  afterEach(() => vi.useRealTimers());

  it('initialises a driver per enabled sensor and persists state on event', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const registry = makeRegistry(repo, () => driver);
    const listener = vi.fn();
    registry.onEvent(listener);

    await registry.reload();

    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    driver.simulateChange(1);
    // persistState is fire-and-forget — wait a microtask
    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sensorId: 'front_door',
        type: 'state_change',
        oldValue: 0,
        newValue: 1,
      }),
    );
    expect(repo.lastValueFor('front_door')).toEqual({ lastValue: '1', lastValueAt: now });
  });

  it('destroys drivers whose sensors are no longer enabled', async () => {
    const sensor = digitalSensor();
    const repo = new InMemorySensorRepository([sensor]);
    const driver = new MockGpioAdapter();
    const destroy = vi.spyOn(driver, 'destroy');
    const registry = makeRegistry(repo, () => driver);

    await registry.reload();
    repo.setSensors([{ ...sensor, enabled: false }]);
    await registry.reload();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(registry.getDriver('front_door')).toBeUndefined();
  });

  it('skips duplicate digital sensors that share a pin', async () => {
    const repo = new InMemorySensorRepository([
      digitalSensor({ id: 'front_door', name: 'Front door', config: { pin: 17 } }),
      digitalSensor({ id: 'back_door', name: 'Back door', config: { pin: 17 } }),
    ]);
    const registry = makeRegistry(repo, () => new MockGpioAdapter());

    await registry.reload();

    expect(registry.list().map((e) => e.id)).toEqual(['front_door']);
  });

  it('logs and skips when a driver fails to init', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    vi.spyOn(driver, 'init').mockRejectedValueOnce(new Error('boom'));
    const registry = makeRegistry(repo, () => driver);

    await registry.reload();

    expect(registry.list()).toHaveLength(0);
  });

  it('retains a startup-unavailable driver and subscribes it for a later rebind', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    let eventListener: ((event: SensorEvent) => void) | undefined;
    const driver: SensorDriverPort = {
      init: vi.fn().mockRejectedValue(new DriverUnavailableError('pigpiod', 'refused')),
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(),
      onEvent: vi.fn((listener: (event: SensorEvent) => void) => {
        eventListener = listener;
      }),
      healthCheck: vi.fn().mockResolvedValue(false),
    };
    const registry = makeRegistry(repo, () => driver);
    const listener = vi.fn();
    registry.onEvent(listener);

    await registry.reload();
    eventListener?.({
      sensorId: 'front_door',
      type: 'state_change',
      oldValue: false,
      newValue: true,
      timestamp: new Date('2030-01-01T00:00:00.000Z'),
    });
    await Promise.resolve();

    expect(registry.getDriver('front_door')).toBe(driver);
    expect(driver.onEvent).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sensorId: 'front_door', newValue: true }),
    );
  });

  it('destroys every active driver on module shutdown', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const destroy = vi.spyOn(driver, 'destroy');
    const registry = makeRegistry(repo, () => driver);

    await registry.reload();
    await registry.onModuleDestroy();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });

  it('onModuleInit triggers a reload', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const registry = makeRegistry(repo, () => new MockGpioAdapter());

    await registry.onModuleInit();

    expect(registry.list()).toHaveLength(1);
  });

  it('continues fanning out to remaining listeners when one throws', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const registry = makeRegistry(repo, () => driver);
    const bad = vi.fn(() => {
      throw new Error('listener broke');
    });
    const good = vi.fn();
    registry.onEvent(bad);
    registry.onEvent(good);
    await registry.reload();

    driver.simulateChange(1);

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('probe() returns online status per active sensor and tolerates failures', async () => {
    const repo = new InMemorySensorRepository([
      digitalSensor({ id: 'ok', name: 'ok', config: { pin: 17 } }),
      digitalSensor({ id: 'bad', name: 'bad', config: { pin: 18 } }),
    ]);
    const goodDriver = new MockGpioAdapter();
    const badDriver = new MockGpioAdapter();
    vi.spyOn(badDriver, 'healthCheck').mockRejectedValue(new Error('boom'));
    const drivers = new Map<string, MockGpioAdapter>([
      ['digital-1', goodDriver],
      ['digital-2', badDriver],
    ]);
    let i = 0;
    const registry = makeRegistry(repo, () => [...drivers.values()][i++]);
    await registry.reload();

    const result = await registry.probe();

    expect(result.get('ok')).toBe(true);
    expect(result.get('bad')).toBe(false);
    expect(result.size).toBe(2);
  });

  it('serializes concurrent reloads so a sensor is initialised once', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    let created = 0;
    const registry = makeRegistry(repo, () => {
      created += 1;
      const driver = new MockGpioAdapter();
      const realInit = driver.init.bind(driver);
      // Slow init widens the interleaving window that the bug relies on.
      driver.init = async (cfg) => {
        await new Promise((r) => setTimeout(r, 5));
        return realInit(cfg);
      };
      return driver;
    });

    await Promise.all([registry.reload(), registry.reload()]);

    expect(created).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });
});
