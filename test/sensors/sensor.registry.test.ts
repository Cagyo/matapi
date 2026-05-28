import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sensors } from '../../src/database/schema';
import { MockGpioDriver } from '../../src/sensors/drivers/mock.driver';
import { PigpioGateway } from '../../src/sensors/drivers/pigpio.gateway';
import { SensorRegistry } from '../../src/sensors/sensor.registry';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../helpers/database';

const originalNodeEnv = process.env.NODE_ENV;

function restoreNodeEnv(): void {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = originalNodeEnv;
}

function makeRegistry(context: TestDatabaseContext): SensorRegistry {
  return new SensorRegistry(context.appDb, {} as PigpioGateway);
}

describe('SensorRegistry', () => {
  let context: TestDatabaseContext;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    context = createTestDatabase();
  });

  afterEach(() => {
    context.close();
    restoreNodeEnv();
    vi.useRealTimers();
  });

  it('loads enabled sensors and fans out driver events while persisting state', async () => {
    context.db
      .insert(sensors)
      .values({
        id: 'front_door',
        name: 'Front door',
        type: 'digital',
        enabled: true,
        config: { pin: 17 },
        debounceMs: 100,
        severity: 'warning',
      })
      .run();
    const registry = makeRegistry(context);
    const listener = vi.fn();
    registry.onEvent(listener);

    await registry.reload();
    const driver = registry.getDriver('front_door');
    expect(driver).toBeInstanceOf(MockGpioDriver);

    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    (driver as MockGpioDriver).simulateChange(1);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sensorId: 'front_door',
        type: 'state_change',
        oldValue: 0,
        newValue: 1,
      }),
    );
    const row = context.db.select().from(sensors).where(eq(sensors.id, 'front_door')).get();
    expect(row?.lastValue).toBe('1');
    expect(row?.lastValueAt?.toISOString()).toBe(now.toISOString());
  });

  it('destroys drivers whose sensors are no longer enabled', async () => {
    context.db
      .insert(sensors)
      .values({
        id: 'front_door',
        name: 'Front door',
        type: 'digital',
        enabled: true,
        config: { pin: 17 },
      })
      .run();
    const registry = makeRegistry(context);
    await registry.reload();
    const driver = registry.getDriver('front_door') as MockGpioDriver;
    const destroy = vi.spyOn(driver, 'destroy');

    context.db.update(sensors).set({ enabled: false }).where(eq(sensors.id, 'front_door')).run();
    await registry.reload();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(registry.getDriver('front_door')).toBeUndefined();
  });

  it('skips duplicate digital sensors that share a GPIO pin', async () => {
    context.db
      .insert(sensors)
      .values([
        {
          id: 'front_door',
          name: 'Front door',
          type: 'digital',
          enabled: true,
          config: { pin: 17 },
        },
        {
          id: 'back_door',
          name: 'Back door',
          type: 'digital',
          enabled: true,
          config: { pin: 17 },
        },
      ])
      .run();
    const registry = makeRegistry(context);

    await registry.reload();

    expect(registry.list()).toHaveLength(1);
  });

  it('skips unknown sensor types', async () => {
    context.db
      .insert(sensors)
      .values({
        id: 'unknown',
        name: 'Mystery',
        type: 'mystery',
        enabled: true,
        config: {},
      })
      .run();
    const registry = makeRegistry(context);

    await registry.reload();

    expect(registry.list()).toEqual([]);
  });

  it('destroys every active driver on module shutdown', async () => {
    context.db
      .insert(sensors)
      .values({
        id: 'front_door',
        name: 'Front door',
        type: 'digital',
        enabled: true,
        config: { pin: 17 },
      })
      .run();
    const registry = makeRegistry(context);
    await registry.reload();
    const driver = registry.getDriver('front_door') as MockGpioDriver;
    const destroy = vi.spyOn(driver, 'destroy');

    await registry.onModuleDestroy();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });
});