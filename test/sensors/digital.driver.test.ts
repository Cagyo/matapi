import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DigitalDriver } from '../../src/sensors/drivers/digital.driver';
import { PigpioGateway, PigpioGpio } from '../../src/sensors/drivers/pigpio.gateway';
import { SensorConfig, SensorEvent } from '../../src/sensors/sensor.interface';

function makeFakeGpio(initialLevel: 0 | 1 = 1) {
  const gpio = {
    modeSet: vi.fn().mockResolvedValue(undefined),
    pullUpDown: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(initialLevel),
    glitchSet: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    endNotify: vi.fn().mockResolvedValue(undefined),
  } as unknown as PigpioGpio & {
    modeSet: ReturnType<typeof vi.fn>;
    pullUpDown: ReturnType<typeof vi.fn>;
    glitchSet: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    endNotify: ReturnType<typeof vi.fn>;
  };
  return gpio;
}

function makeGateway(gpio: PigpioGpio) {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    gpio: vi.fn().mockReturnValue(gpio),
  } as unknown as PigpioGateway;
}

const baseConfig: SensorConfig = {
  id: 'sensor_1',
  name: 'front_door',
  type: 'digital',
  config: { pin: 17, activeLow: true, pull: 'up' },
  debounceMs: 100,
  severity: 'info',
};

describe('DigitalDriver', () => {
  let gpio: ReturnType<typeof makeFakeGpio>;
  let gateway: PigpioGateway;
  let driver: DigitalDriver;

  beforeEach(() => {
    gpio = makeFakeGpio(1); // pin pulled high → not triggered (active-low)
    gateway = makeGateway(gpio);
    driver = new DigitalDriver(gateway);
  });

  it('initialises pin as input with pull-up and registers notify', async () => {
    await driver.init(baseConfig);
    expect(gpio.modeSet).toHaveBeenCalledWith('input');
    expect(gpio.pullUpDown).toHaveBeenCalledWith(2); // pud=2 = up
    expect(gpio.glitchSet).toHaveBeenCalled();
    expect(gpio.notify).toHaveBeenCalledTimes(1);
    expect(driver.getState().value).toBe(false); // level=1, activeLow → false
  });

  it('emits state_change event when pin level transitions', async () => {
    const events: SensorEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.init(baseConfig);

    const notifyCb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      level: 0 | 1,
    ) => void;
    notifyCb(0); // door opened (active-low)

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sensorId: 'sensor_1',
      type: 'state_change',
      oldValue: false,
      newValue: true,
    });
    expect(driver.getState().value).toBe(true);
  });

  it('respects activeLow=false (active-high)', async () => {
    await driver.init({
      ...baseConfig,
      config: { pin: 17, activeLow: false, pull: 'down' },
    });
    expect(gpio.pullUpDown).toHaveBeenCalledWith(1); // pud=1 = down
    // initial read returned 1 → activeHigh → true
    expect(driver.getState().value).toBe(true);
  });

  it('debounces repeated transitions within debounceMs window', async () => {
    const events: SensorEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.init({ ...baseConfig, debounceMs: 1000 });

    const notifyCb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      level: 0 | 1,
    ) => void;

    notifyCb(0); // first transition emits
    notifyCb(1); // second transition within window — suppressed
    notifyCb(0);
    expect(events).toHaveLength(1);
  });

  it('rejects out-of-range pin', async () => {
    await expect(
      driver.init({ ...baseConfig, config: { pin: 99 } }),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects missing pin', async () => {
    await expect(
      driver.init({ ...baseConfig, config: {} as Record<string, unknown> }),
    ).rejects.toThrow(/missing required numeric "pin"/);
  });

  it('destroy unregisters notify', async () => {
    await driver.init(baseConfig);
    await driver.destroy();
    expect(gpio.endNotify).toHaveBeenCalled();
  });

  it('healthCheck returns true when pin reads succeed', async () => {
    await driver.init(baseConfig);
    expect(await driver.healthCheck()).toBe(true);
  });

  it('healthCheck returns false and marks offline on read failure', async () => {
    await driver.init(baseConfig);
    (gpio.read as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('socket gone'));
    expect(await driver.healthCheck()).toBe(false);
    expect(await driver.healthCheck()).toBe(false); // sticky offline
  });

  it('getPin static helper extracts pin from raw config', () => {
    expect(DigitalDriver.getPin({ pin: 17 })).toBe(17);
    expect(DigitalDriver.getPin({})).toBeNull();
    expect(DigitalDriver.getPin(null)).toBeNull();
  });
});
