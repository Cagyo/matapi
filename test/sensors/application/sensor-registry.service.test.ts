import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { SensorDriverPort } from '../../../src/sensors/domain/ports/sensor-driver.port';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';
import { MockGpioAdapter } from '../../../src/sensors/infrastructure/mock-gpio.adapter';
import { DriverUnavailableError } from '../../../src/sensors/domain/errors/driver-unavailable.error';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';

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

function availableFeatures(): FeatureAvailabilityPort {
  return {
    awaitInitialVerification: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn(),
    requireReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeatureAvailabilityPort;
}

function makeRegistry(
  repo: InMemorySensorRepository,
  factory: (type: string) => SensorDriverPort,
  availability = availableFeatures(),
) {
  return new SensorRegistryService(repo, factory, availability);
}

async function flushEvents(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
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
    await flushEvents();

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

  it('awaits initial feature verification before constructing a mapped driver', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    let release!: () => void;
    const availability = availableFeatures();
    vi.mocked(availability.awaitInitialVerification).mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const factory = vi.fn(() => new MockGpioAdapter());
    const registry = makeRegistry(repo, factory, availability);

    const reload = registry.reload();
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();

    release();
    await reload;
    expect(factory).toHaveBeenCalledOnce();
  });

  it('does not construct unavailable mapped drivers but leaves camera drivers unaffected', async () => {
    const repo = new InMemorySensorRepository([
      digitalSensor(),
      digitalSensor({ id: 'camera', name: 'Camera', type: 'camera', config: { source: 'usb' } }),
    ]);
    const availability = availableFeatures();
    vi.mocked(availability.requireReady).mockImplementation(async (name) => {
      if (name === 'digital') throw new FeatureUnavailableError('digital', 'installed-off');
    });
    const factory = vi.fn(() => new MockGpioAdapter());
    const registry = makeRegistry(repo, factory, availability);

    await registry.reload();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('camera');
    expect(registry.list().map(({ id }) => id)).toEqual(['camera']);
  });

  it('destroys active drivers when their mapped feature becomes unavailable', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const destroy = vi.spyOn(driver, 'destroy');
    const availability = availableFeatures();
    const registry = makeRegistry(repo, () => driver, availability);
    await registry.reload();
    vi.mocked(availability.requireReady).mockRejectedValueOnce(
      new FeatureUnavailableError('digital', 'installed-off'),
    );

    await registry.reload();

    expect(destroy).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(0);
  });

  it('blocks stopped features from being recreated until they are resumed', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const first = new MockGpioAdapter();
    const second = new MockGpioAdapter();
    const firstDestroy = vi.spyOn(first, 'destroy');
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const registry = makeRegistry(repo, factory);
    await registry.reload();

    await registry.stopFeature('digital');
    await registry.reload();
    expect(firstDestroy).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();

    await registry.resumeFeature('digital');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(registry.getDriver('front_door')).toBe(second);
  });

  it('drops stale or unavailable driver callbacks before persistence and listeners', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const first = new MockGpioAdapter();
    const second = new MockGpioAdapter();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const availability = availableFeatures();
    const registry = makeRegistry(repo, factory, availability);
    const listener = vi.fn();
    registry.onEvent(listener);
    await registry.reload();
    repo.setSensors([digitalSensor({ config: { pin: 18 } })]);
    await registry.reload();

    first.simulateChange(1);
    await flushEvents();
    expect(listener).not.toHaveBeenCalled();
    expect(repo.lastValueFor('front_door')).toEqual({ lastValue: null, lastValueAt: null });

    vi.mocked(availability.requireReady).mockRejectedValueOnce(
      new FeatureUnavailableError('digital', 'installed-off'),
    );
    second.simulateChange(1);
    await flushEvents();
    expect(listener).not.toHaveBeenCalled();
    expect(repo.lastValueFor('front_door')).toEqual({ lastValue: null, lastValueAt: null });
  });

  it('drops listeners when availability changes while an event is being persisted', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const availability = availableFeatures();
    let ready = true;
    vi.mocked(availability.requireReady).mockImplementation(async () => {
      if (!ready) throw new FeatureUnavailableError('digital', 'installed-off');
    });
    const updateState = vi.spyOn(repo, 'updateState').mockImplementation(async (...args) => {
      ready = false;
      return InMemorySensorRepository.prototype.updateState.apply(repo, args);
    });
    const registry = makeRegistry(repo, () => driver, availability);
    const listener = vi.fn();
    registry.onEvent(listener);
    await registry.reload();

    driver.simulateChange(1);
    await flushEvents();

    expect(updateState).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it('persists the current UART ppm rather than a threshold event level', async () => {
    const co2 = digitalSensor({
      id: 'co2',
      name: 'CO2',
      type: 'uart',
      config: { port: '/dev/serial0', thresholds: { warning: 800, critical: 1200 } },
    });
    const repo = new InMemorySensorRepository([co2]);
    let eventListener: ((event: SensorEvent) => void) | undefined;
    const driver: SensorDriverPort = {
      init: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({ value: 1250.5, timestamp: new Date('2030-01-01T00:00:00.000Z') })),
      onEvent: vi.fn((listener: (event: SensorEvent) => void) => {
        eventListener = listener;
      }),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const registry = makeRegistry(repo, () => driver);
    await registry.reload();

    const timestamp = new Date('2030-01-01T00:00:00.000Z');
    eventListener?.({
      sensorId: 'co2',
      type: 'threshold',
      oldValue: 'normal',
      newValue: 'critical',
      timestamp,
    });
    await flushEvents();

    expect(repo.lastValueFor('co2')).toEqual({ lastValue: '1250.5', lastValueAt: timestamp });
  });

  it('persists a small UART reading with Number stringification', async () => {
    const co2 = digitalSensor({
      id: 'co2',
      name: 'CO2',
      type: 'uart',
      config: { port: '/dev/serial0', thresholds: { warning: 3000, critical: 6000 } },
    });
    const repo = new InMemorySensorRepository([co2]);
    let eventListener: ((event: SensorEvent) => void) | undefined;
    const driver: SensorDriverPort = {
      init: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({ value: 1e-7, timestamp: new Date('2030-01-01T00:00:00.000Z') })),
      onEvent: vi.fn((listener: (event: SensorEvent) => void) => {
        eventListener = listener;
      }),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const registry = makeRegistry(repo, () => driver);
    await registry.reload();

    const timestamp = new Date('2030-01-01T00:00:00.000Z');
    eventListener?.({
      sensorId: 'co2',
      type: 'threshold',
      oldValue: 'normal',
      newValue: 'warning',
      timestamp,
    });
    await flushEvents();

    expect(repo.lastValueFor('co2')).toEqual({ lastValue: '1e-7', lastValueAt: timestamp });
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

  it('replaces an active driver when its sensor configuration changes', async () => {
    const initial = digitalSensor({ config: { pin: 11 } });
    const repo = new InMemorySensorRepository([initial]);
    const firstDriver = new MockGpioAdapter();
    const replacementDriver = new MockGpioAdapter();
    const destroy = vi.spyOn(firstDriver, 'destroy');
    const factory = vi
      .fn<(type: string) => SensorDriverPort>()
      .mockReturnValueOnce(firstDriver)
      .mockReturnValueOnce(replacementDriver);
    const registry = makeRegistry(repo, factory);

    await registry.reload();
    repo.setSensors([{ ...initial, config: { pin: 17 } }]);
    await registry.reload();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(registry.getDriver('front_door')).toBe(replacementDriver);
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

  it('does not log raw third-party driver or reload errors during shutdown', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    vi.spyOn(driver, 'init').mockRejectedValueOnce(
      new Error('raw driver error mqtt://user:secret@broker.example password=another-secret'),
    );
    const registry = makeRegistry(repo, () => driver);

    await registry.reload();
    (registry as SensorRegistryService & { reloadChain: Promise<void> }).reloadChain =
      Promise.reject(new Error('raw reload error password=another-secret'));
    await registry.shutdown();

    const messages = [...error.mock.calls, ...warn.mock.calls].map(([message]) => String(message));
    expect(messages.join('\n')).not.toContain('raw driver error');
    expect(messages.join('\n')).not.toContain('raw reload error');
    expect(messages.join('\n')).not.toContain('another-secret');
    expect(messages.join('\n')).not.toContain('user');
    expect(messages.join('\n')).not.toContain('secret');
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
    await flushEvents();

    expect(registry.getDriver('front_door')).toBe(driver);
    expect(driver.onEvent).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sensorId: 'front_door', newValue: true }),
    );
  });

  it('shares shutdown work, destroys every active driver, and prevents reloads after shutdown starts', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const destroy = vi.spyOn(driver, 'destroy');
    const factory = vi.fn(() => driver);
    const registry = makeRegistry(repo, factory);

    await registry.reload();
    const shutdown = registry as SensorRegistryService & { shutdown(): Promise<void> };
    const first = shutdown.shutdown();
    const second = shutdown.shutdown();
    repo.setSensors([
      digitalSensor({ id: 'back_door', name: 'Back door', config: { pin: 18 } }),
    ]);
    await shutdown.reload();
    await first;

    expect(second).toBe(first);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
    expect(registry.getDriver('back_door')).toBeUndefined();
  });

  it('passes each shutdown driver a cancellable deadline context', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const destroy = vi.spyOn(driver, 'destroy');
    const registry = makeRegistry(repo, () => driver);

    await registry.reload();
    await registry.shutdown();

    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        deadlineAt: expect.any(Number),
      }),
    );
  });

  it('does not finish shutdown while an active driver is still destroying', async () => {
    vi.useFakeTimers();
    const repo = new InMemorySensorRepository([digitalSensor()]);
    let finishDestroy!: () => void;
    const destroy = vi.fn(
      () => new Promise<void>((resolve) => {
        finishDestroy = resolve;
      }),
    );
    const driver: SensorDriverPort = {
      init: vi.fn().mockResolvedValue(undefined),
      destroy,
      getState: vi.fn(),
      onEvent: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const registry = makeRegistry(repo, () => driver);
    await registry.reload();

    let settled = false;
    const shutdown = registry.shutdown().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finishDestroy();
    await shutdown;
    expect(settled).toBe(true);
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
    await flushEvents();

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('probe() reports active driver failures as failed data', async () => {
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

    const result = await registry.probe(['ok', 'bad'], 5_000);

    expect(result).toEqual([
      { sensorId: 'ok', status: 'online' },
      { sensorId: 'bad', status: 'failed' },
    ]);
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
