import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DigitalGpioAdapter } from '../../../src/sensors/infrastructure/digital-gpio.adapter';
import {
  PigpioConnectionState,
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
  let state: PigpioConnectionState = { connected, generation: connected ? 1 : 0 };
  const connectionStateListeners = new Set<(state: PigpioConnectionState) => void>();
  const unsubscribe = vi.fn();
  const publishConnectionState = (next: PigpioConnectionState) => {
    state = next;
    for (const listener of connectionStateListeners) listener(next);
  };
  return {
    isConnected: vi.fn(() => state.connected),
    connect: vi.fn(async () => {
      if (!state.connected) {
        publishConnectionState({ connected: true, generation: state.generation + 1 });
      }
    }),
    gpio: vi.fn().mockReturnValue(gpio),
    connectionState: vi.fn(() => state),
    onConnectionState: vi.fn((listener: (next: PigpioConnectionState) => void) => {
      connectionStateListeners.add(listener);
      return () => {
        unsubscribe();
        connectionStateListeners.delete(listener);
      };
    }),
    publishConnectionState,
    unsubscribe,
  } as unknown as PigpioGateway & {
    isConnected: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    gpio: ReturnType<typeof vi.fn>;
    connectionState: ReturnType<typeof vi.fn>;
    onConnectionState: ReturnType<typeof vi.fn>;
    publishConnectionState: (state: PigpioConnectionState) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
}

async function flushRebind(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

  it('emits a flapping fault event when the circuit breaker engages', async () => {
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init({ ...baseConfig, debounceMs: 0 });

    const cb = gpio.notify.mock.calls[0][0] as (level: 0 | 1) => void;
    for (let index = 0; index < 31; index += 1) cb((index % 2) as 0 | 1);

    expect(events).toContainEqual(
      expect.objectContaining({
        sensorId: 'sensor_1',
        type: 'error',
        newValue: 'flapping_fault',
      }),
    );
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

  it('preserves its connection subscription after an unavailable startup connection', async () => {
    gateway.isConnected.mockReturnValue(false);
    gateway.connect.mockRejectedValueOnce(new Error('refused'));
    await expect(adapter.init(baseConfig)).rejects.toThrow(DriverUnavailableError);

    gateway.publishConnectionState({ connected: true, generation: 1 });
    await flushRebind();

    expect(gpio.modeSet).toHaveBeenCalledWith('input');
    expect(gpio.notify).toHaveBeenCalledTimes(1);
  });

  it('restores a fresh GPIO binding once per generation and ignores stale notifications', async () => {
    const gpioA = makeFakeGpio(1);
    const gpioB = makeFakeGpio(0);
    gateway = makeGateway(gpioA);
    gateway.gpio.mockReturnValueOnce(gpioA).mockReturnValue(gpioB);
    adapter = new DigitalGpioAdapter(gateway);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.init({ ...baseConfig, debounceMs: 0 });
    const staleCallback = gpioA.notify.mock.calls[0][0] as (level: 0 | 1) => void;

    gateway.publishConnectionState({ connected: false, generation: 1 });
    gateway.publishConnectionState({ connected: true, generation: 2 });
    await flushRebind();

    expect(gpioA.endNotify).toHaveBeenCalledTimes(1);
    expect(gpioB.modeSet).toHaveBeenCalledTimes(1);
    expect(gpioB.modeSet).toHaveBeenCalledWith('input');
    expect(gpioB.pullUpDown).toHaveBeenCalledWith(2);
    expect(gpioB.glitchSet).toHaveBeenCalledTimes(1);
    expect(gpioB.read).toHaveBeenCalledTimes(1);
    expect(gpioB.notify).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({ oldValue: false, newValue: true }),
    ]);

    staleCallback(1);
    expect(events).toHaveLength(1);

    const restoredCallback = gpioB.notify.mock.calls[0][0] as (level: 0 | 1) => void;
    restoredCallback(1);
    expect(events).toEqual([
      expect.objectContaining({ oldValue: false, newValue: true }),
      expect.objectContaining({ oldValue: true, newValue: false }),
    ]);

    gateway.publishConnectionState({ connected: true, generation: 2 });
    await flushRebind();
    expect(gpioB.notify).toHaveBeenCalledTimes(1);
  });

  it('keeps a restored GPIO binding in polled mode while the flap breaker is active', async () => {
    const gpioA = makeFakeGpio(1);
    const gpioB = makeFakeGpio(1);
    gateway = makeGateway(gpioA);
    gateway.gpio.mockReturnValueOnce(gpioA).mockReturnValue(gpioB);
    adapter = new DigitalGpioAdapter(gateway);
    await adapter.init({ ...baseConfig, debounceMs: 0 });
    const callback = gpioA.notify.mock.calls[0][0] as (level: 0 | 1) => void;

    for (let index = 0; index < 31; index += 1) callback((index % 2) as 0 | 1);
    expect(gpioA.endNotify).toHaveBeenCalled();

    gateway.publishConnectionState({ connected: false, generation: 1 });
    gateway.publishConnectionState({ connected: true, generation: 2 });
    await flushRebind();

    expect(gpioB.modeSet).toHaveBeenCalledTimes(1);
    expect(gpioB.notify).not.toHaveBeenCalled();
    await adapter.destroy();
  });

  it('ignores a stale polled read after the GPIO binding is restored', async () => {
    vi.useFakeTimers();
    const gpioA = makeFakeGpio(1);
    const gpioB = makeFakeGpio(1);
    let resolveStaleRead: ((level: 0 | 1) => void) | undefined;
    gateway = makeGateway(gpioA);
    gateway.gpio.mockReturnValueOnce(gpioA).mockReturnValue(gpioB);
    adapter = new DigitalGpioAdapter(gateway);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init({ ...baseConfig, debounceMs: 0 });
    const callback = gpioA.notify.mock.calls[0][0] as (level: 0 | 1) => void;

    for (let index = 0; index < 31; index += 1) callback((index % 2) as 0 | 1);
    events.length = 0;
    gpioA.read.mockImplementationOnce(
      () => new Promise<0 | 1>((resolve) => {
        resolveStaleRead = resolve;
      }),
    );

    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(resolveStaleRead).toBeTypeOf('function');

    gateway.publishConnectionState({ connected: false, generation: 1 });
    gateway.publishConnectionState({ connected: true, generation: 2 });
    await flushRebind();
    expect(adapter.getState().value).toBe(false);

    resolveStaleRead?.(0);
    await Promise.resolve();

    expect(events).toEqual([]);
    expect(adapter.getState()).toMatchObject({ value: false, raw: 1 });
    await adapter.destroy();
    vi.useRealTimers();
  });

  it('unsubscribes before destruction and ignores queued or later connection states', async () => {
    const gpioA = makeFakeGpio(1);
    const gpioB = makeFakeGpio(1);
    let resolveModeSet: (() => void) | undefined;
    gpioB.modeSet.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveModeSet = resolve;
      }),
    );
    gateway = makeGateway(gpioA);
    gateway.gpio.mockReturnValueOnce(gpioA).mockReturnValue(gpioB);
    adapter = new DigitalGpioAdapter(gateway);
    await adapter.init(baseConfig);

    gateway.publishConnectionState({ connected: false, generation: 1 });
    gateway.publishConnectionState({ connected: true, generation: 2 });
    await flushRebind();
    expect(gpioB.modeSet).toHaveBeenCalledTimes(1);
    const destroy = adapter.destroy();
    expect(gateway.unsubscribe).toHaveBeenCalledTimes(1);
    resolveModeSet?.();
    await destroy;
    gateway.publishConnectionState({ connected: true, generation: 3 });
    await flushRebind();

    expect(gpioB.notify).not.toHaveBeenCalled();
    expect(gpioA.endNotify).toHaveBeenCalledTimes(1);
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

  it('records state change to sensor_logs when repository is provided', async () => {
    const logs = { appendBatch: vi.fn().mockResolvedValue(undefined), findRecent: vi.fn() };
    const loggedAdapter = new DigitalGpioAdapter(gateway, logs);
    await loggedAdapter.init({ ...baseConfig, debounceMs: 0 });

    const cb = gpio.notify.mock.calls[0][0];
    cb(0); // activeLow: 0 is active/true

    expect(logs.appendBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sensorId: 'sensor_1',
        level: 'info',
        message: 'State changed: CLOSED → OPEN',
      }),
    ]);
  });

  it('records debounce triggered warning to sensor_logs when bouncing occurs', async () => {
    vi.useFakeTimers();
    const logs = { appendBatch: vi.fn().mockResolvedValue(undefined), findRecent: vi.fn() };
    const loggedAdapter = new DigitalGpioAdapter(gateway, logs);
    await loggedAdapter.init({ ...baseConfig, debounceMs: 500 });

    const cb = gpio.notify.mock.calls[0][0];
    cb(0); // transition 0 -> active
    vi.advanceTimersByTime(100);
    cb(1); // bounce back to 1 while debounce timer is active

    expect(logs.appendBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sensorId: 'sensor_1',
        level: 'warn',
        message: expect.stringContaining('Debounce triggered'),
      }),
    ]);
    vi.useRealTimers();
  });

  it('records flapping fault warning to sensor_logs when circuit breaker trips', async () => {
    vi.useFakeTimers();
    const logs = { appendBatch: vi.fn().mockResolvedValue(undefined), findRecent: vi.fn() };
    const loggedAdapter = new DigitalGpioAdapter(gateway, logs);
    await loggedAdapter.init(baseConfig);

    const cb = gpio.notify.mock.calls[0][0];
    for (let i = 0; i < 35; i++) {
      vi.advanceTimersByTime(1000);
      cb(i % 2);
    }

    expect(logs.appendBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sensorId: 'sensor_1',
        level: 'warn',
        message: expect.stringContaining('flapping!'),
      }),
    ]);
    vi.useRealTimers();
  });

  it('resumes hardware notifications after the flap cooldown', async () => {
    vi.useFakeTimers();
    await adapter.init(baseConfig);
    const cb = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as (l: 0 | 1) => void;

    // Trip the anti-flap breaker: >30 transitions inside the 60s window.
    for (let i = 0; i < 32; i += 1) cb((i % 2) as 0 | 1);
    expect(gpio.endNotify).toHaveBeenCalled(); // switched to polled mode
    const notifyCallsBefore = (gpio.notify as ReturnType<typeof vi.fn>).mock.calls.length;

    // Advance past the recovery window; the 10s polled tick performs the check.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000);

    expect((gpio.notify as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      notifyCallsBefore,
    );
    vi.useRealTimers();
  });
});
