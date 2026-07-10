import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { SensorDriverPort } from '../../../src/sensors/domain/ports/sensor-driver.port';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';
import { SensorResourcesLifecycleAdapter } from '../../../src/sensors/infrastructure/sensor-resources-lifecycle.adapter';

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SensorResourcesLifecycleAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('finishes every driver before closing shared gateways and shares one teardown', async () => {
    const order: string[] = [];
    const firstDestroy = deferred();
    const firstDriver: SensorDriverPort = {
      init: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(async () => {
        order.push('first:start');
        await firstDestroy.promise;
        order.push('first:end');
        throw new Error('first destroy failed');
      }),
      getState: vi.fn(),
      onEvent: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const secondDriver: SensorDriverPort = {
      init: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(async () => {
        order.push('second:start');
        order.push('second:end');
      }),
      getState: vi.fn(),
      onEvent: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const registry = new SensorRegistryService(
      new InMemorySensorRepository([
        digitalSensor(),
        digitalSensor({ id: 'back_door', name: 'Back door', config: { pin: 18 } }),
      ]),
      vi.fn().mockReturnValueOnce(firstDriver).mockReturnValueOnce(secondDriver),
    );
    await registry.reload();

    const pigpio = {
      close: vi.fn(async () => {
        order.push('pigpio');
      }),
    };
    const mqtt = {
      beginLifecycleShutdown: vi.fn(),
      destroyAll: vi.fn(async () => {
        order.push('mqtt');
      }),
    };
    const lifecycle = new SensorResourcesLifecycleAdapter(
      registry,
      pigpio as never,
      mqtt as never,
    );

    const first = lifecycle.onModuleDestroy();
    const second = lifecycle.onModuleDestroy();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(pigpio.close).not.toHaveBeenCalled();
    expect(mqtt.destroyAll).not.toHaveBeenCalled();

    firstDestroy.resolve();
    await first;

    expect(firstDriver.destroy).toHaveBeenCalledTimes(1);
    expect(secondDriver.destroy).toHaveBeenCalledTimes(1);
    expect(pigpio.close).toHaveBeenCalledTimes(1);
    expect(mqtt.destroyAll).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'pigpio',
      'mqtt',
    ]);
  });

  it('contains shared close errors without logging credentials', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const registry = new SensorRegistryService(new InMemorySensorRepository([]), vi.fn());
    const lifecycle = new SensorResourcesLifecycleAdapter(
      registry,
      {
        close: vi.fn().mockRejectedValue(new Error('mqtt://user:secret@broker.example')),
      } as never,
      {
        beginLifecycleShutdown: vi.fn(),
        destroyAll: vi.fn().mockResolvedValue(undefined),
      } as never,
    );

    await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Pigpio gateway close failed');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret'));
  });

  it('does not close shared gateways while a driver destroy is still pending', async () => {
    vi.useFakeTimers();
    let finishDestroy!: () => void;
    const driver: SensorDriverPort = {
      init: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(
        () => new Promise<void>((resolve) => {
          finishDestroy = resolve;
        }),
      ),
      getState: vi.fn(),
      onEvent: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const registry = new SensorRegistryService(
      new InMemorySensorRepository([digitalSensor()]),
      vi.fn(() => driver),
    );
    await registry.reload();
    const pigpio = { close: vi.fn().mockResolvedValue(undefined) };
    const mqtt = {
      beginLifecycleShutdown: vi.fn(),
      destroyAll: vi.fn().mockResolvedValue(undefined),
    };
    const lifecycle = new SensorResourcesLifecycleAdapter(
      registry,
      pigpio as never,
      mqtt as never,
    );

    let settled = false;
    const shutdown = lifecycle.onModuleDestroy().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(pigpio.close).not.toHaveBeenCalled();
    expect(mqtt.destroyAll).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    finishDestroy();
    await shutdown;
    expect(pigpio.close).toHaveBeenCalledTimes(1);
    expect(mqtt.destroyAll).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  });
});
