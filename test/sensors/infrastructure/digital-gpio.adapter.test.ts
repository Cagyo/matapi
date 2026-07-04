import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DigitalGpioAdapter } from '../../../src/sensors/infrastructure/digital-gpio.adapter';
import {
  PigpioGateway,
  PigpioGpio,
} from '../../../src/sensors/infrastructure/pigpio.gateway';
import { DigitalConfigInvalidError } from '../../../src/sensors/domain/errors/digital-config-invalid.error';
import { DriverUnavailableError } from '../../../src/sensors/domain/errors/driver-unavailable.error';
import { InvalidGpioPinError } from '../../../src/sensors/domain/errors/invalid-gpio-pin.error';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';

function makeFakeGpio(initialLevel: 0 | 1 = 1) {
  return {
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
    read: ReturnType<typeof vi.fn>;
  };
}

function makeGateway(gpio: PigpioGpio, connected = true) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    connect: vi.fn().mockResolvedValue(undefined),
    gpio: vi.fn().mockReturnValue(gpio),
  } as unknown as PigpioGateway & {
    isConnected: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    gpio: ReturnType<typeof vi.fn>;
  };
}

const baseConfig: SensorConfig = {
  id: 'sensor_1',
  name: 'front_door',
  type: 'digital',
  config: { pin: 17, activeLow: true, pull: 'up' },
  debounceMs: 100,
  severity: 'info',
};

describe('DigitalGpioAdapter', () => {
  let gpio: ReturnType<typeof makeFakeGpio>;
  let gateway: ReturnType<typeof makeGateway>;
  let adapter: DigitalGpioAdapter;

  beforeEach(() => {
    gpio = makeFakeGpio(1); // active-low → idle high
    gateway = makeGateway(gpio);
    adapter = new DigitalGpioAdapter(gateway);
  });

  it('initialises pin as input with pull-up and registers notify', async () => {
    await adapter.init(baseConfig);
    expect(gpio.modeSet).toHaveBeenCalledWith('input');
    expect(gpio.pullUpDown).toHaveBeenCalledWith(2);
    expect(gpio.glitchSet).toHaveBeenCalled();
    expect(gpio.notify).toHaveBeenCalledTimes(1);
    expect(adapter.getState().value).toBe(false);
  });

  it('emits state_change when pin level transitions', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init(baseConfig);

    const cb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (l: 0 | 1) => void;
    cb(0);
    vi.advanceTimersByTime(100);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sensorId: 'sensor_1',
      type: 'state_change',
      oldValue: false,
      newValue: true,
    });
    vi.useRealTimers();
  });

  it('respects activeLow=false', async () => {
    await adapter.init({
      ...baseConfig,
      config: { pin: 17, activeLow: false, pull: 'down' },
    });
    expect(gpio.pullUpDown).toHaveBeenCalledWith(1);
    expect(adapter.getState().value).toBe(true);
  });

  it('respects invert=false aliasing activeLow', async () => {
    await adapter.init({
      ...baseConfig,
      config: { pin: 17, invert: false, pull: 'down' },
    });
    expect(adapter.getState().value).toBe(true);
  });

  it('debounces transitions within window', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init({ ...baseConfig, debounceMs: 1000 });

    const cb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (l: 0 | 1) => void;
    cb(0);
    vi.advanceTimersByTime(300);
    cb(1);
    vi.advanceTimersByTime(300);
    cb(0);
    vi.advanceTimersByTime(1000);

    expect(events).toHaveLength(1);
    vi.useRealTimers();
  });

  it('uses asymmetric debounce for leak_hazard (fast trigger, slow release)', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init({
      ...baseConfig,
      config: { pin: 17, stepType: 'leak_hazard', activeLow: true },
      debounceMs: 5000, // 5s requested
    });

    const cb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (l: 0 | 1) => void;
    // Rising edge (dry -> leak): capped at 50ms
    cb(0);
    vi.advanceTimersByTime(50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ oldValue: false, newValue: true });

    // Falling edge (leak -> dry): min 60s cooldown
    cb(1);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1); // still 1!
    vi.advanceTimersByTime(55_000);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ oldValue: true, newValue: false });
    vi.useRealTimers();
  });

  it('uses asymmetric debounce for motion (instant trigger, cooldown release)', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init({
      ...baseConfig,
      config: { pin: 17, stepType: 'motion', activeLow: true },
      debounceMs: 1000,
    });

    const cb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (l: 0 | 1) => void;
    // Rising edge: 0ms instant
    cb(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ oldValue: false, newValue: true });

    // Falling edge: min 5000ms cooldown
    cb(1);
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(events).toHaveLength(2);
    vi.useRealTimers();
  });

  it('triggers circuit breaker on flapping (>30 transitions/min) and switches to polled mode', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init({ ...baseConfig, debounceMs: 0 });

    const cb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (l: 0 | 1) => void;
    // Emit 31 rapid transitions
    for (let i = 0; i <= 30; i++) {
      cb((i % 2) as 0 | 1);
    }

    expect(gpio.endNotify).toHaveBeenCalled();

    // Now in polled mode (every 10s)
    gpio.read.mockResolvedValue(0); // level 0 -> true
    vi.advanceTimersByTime(10_000);
    expect(gpio.read).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('rejects out-of-range pin with InvalidGpioPinError', async () => {
    await expect(adapter.init({ ...baseConfig, config: { pin: 99 } })).rejects.toThrow(
      InvalidGpioPinError,
    );
  });

  it('rejects missing pin with DigitalConfigInvalidError', async () => {
    await expect(
      adapter.init({ ...baseConfig, config: {} }),
    ).rejects.toThrow(DigitalConfigInvalidError);
  });

  it('rejects invalid pull mode with DigitalConfigInvalidError', async () => {
    await expect(
      adapter.init({ ...baseConfig, config: { pin: 17, pull: 'sideways' } }),
    ).rejects.toThrow(DigitalConfigInvalidError);
  });

  it('connects gateway when disconnected', async () => {
    gateway.isConnected.mockReturnValue(false);
    await adapter.init(baseConfig);
    expect(gateway.connect).toHaveBeenCalledTimes(1);
  });

  it('throws DriverUnavailableError when gateway connect fails', async () => {
    gateway.isConnected.mockReturnValue(false);
    gateway.connect.mockRejectedValueOnce(new Error('refused'));
    await expect(adapter.init(baseConfig)).rejects.toThrow(DriverUnavailableError);
  });

  it('destroy unregisters notify and clears timers/intervals', async () => {
    await adapter.init(baseConfig);
    await adapter.destroy();
    expect(gpio.endNotify).toHaveBeenCalled();
  });

  it('healthCheck returns true when read succeeds', async () => {
    await adapter.init(baseConfig);
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('healthCheck returns false and stays offline after a read failure', async () => {
    await adapter.init(baseConfig);
    gpio.read.mockRejectedValueOnce(new Error('socket gone'));
    expect(await adapter.healthCheck()).toBe(false);
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('getPin static helper extracts numeric pin', () => {
    expect(DigitalGpioAdapter.getPin({ pin: 17 })).toBe(17);
    expect(DigitalGpioAdapter.getPin({})).toBeNull();
    expect(DigitalGpioAdapter.getPin(null)).toBeNull();
  });
});
