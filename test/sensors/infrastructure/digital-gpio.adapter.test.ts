import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DigitalGpioAdapter } from '../../../src/sensors/infrastructure/digital-gpio.adapter';
import {
  GpioBackendPort,
  GpioBackendState,
  GpioLine,
} from '../../../src/sensors/infrastructure/gpio-backend.port';
import { DigitalConfigInvalidError } from '../../../src/sensors/domain/errors/digital-config-invalid.error';
import { DriverUnavailableError } from '../../../src/sensors/domain/errors/driver-unavailable.error';
import { InvalidGpioPinError } from '../../../src/sensors/domain/errors/invalid-gpio-pin.error';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';

function makeFakeLine(initialLevel: 0 | 1 = 1) {
  const watchers: ((level: 0 | 1) => void)[] = [];
  const line = {
    configure: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(initialLevel),
    watch: vi.fn(async (onLevel: (level: 0 | 1) => void) => {
      watchers.push(onLevel);
    }),
    unwatch: vi.fn(async () => {
      watchers.length = 0;
    }),
    emit(level: 0 | 1) {
      for (const watcher of [...watchers]) watcher(level);
    },
  };
  // Type-checked against the real port — the reason the interface exists.
  const _typecheck: GpioLine = line;
  void _typecheck;
  return line;
}

function makeBackend(line: ReturnType<typeof makeFakeLine>, available = true) {
  let state: GpioBackendState = { available, generation: available ? 1 : 0 };
  const listeners = new Set<(state: GpioBackendState) => void>();
  const unsubscribe = vi.fn();
  const publishState = (next: GpioBackendState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const backend = {
    connect: vi.fn(async () => {
      if (!state.available) publishState({ available: true, generation: state.generation + 1 });
    }),
    isAvailable: vi.fn(() => state.available),
    state: vi.fn(() => state),
    onStateChange: vi.fn((listener: (next: GpioBackendState) => void) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    }),
    line: vi.fn(() => line),
    close: vi.fn(async () => undefined),
    publishState,
    unsubscribe,
  };
  const _typecheck: GpioBackendPort = backend;
  void _typecheck;
  return backend;
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
  let line: ReturnType<typeof makeFakeLine>;
  let backend: ReturnType<typeof makeBackend>;
  let adapter: DigitalGpioAdapter;

  beforeEach(() => {
    line = makeFakeLine(1); // active-low → idle high
    backend = makeBackend(line);
    adapter = new DigitalGpioAdapter(backend);
  });

  it('initialises pin with pull-up bias and debounce, and starts watching', async () => {
    await adapter.init(baseConfig);
    expect(line.configure).toHaveBeenCalledWith({ bias: 'up', debounceUs: 10_000 });
    expect(line.watch).toHaveBeenCalledTimes(1);
    expect(adapter.getState().value).toBe(false);
  });

  it('emits state_change when pin level transitions', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.init(baseConfig);

    line.emit(0);
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
    expect(line.configure).toHaveBeenCalledWith({ bias: 'down', debounceUs: 10_000 });
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

    line.emit(0);
    vi.advanceTimersByTime(300);
    line.emit(1);
    vi.advanceTimersByTime(300);
    line.emit(0);
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

    // Rising edge (dry -> leak): capped at 50ms
    line.emit(0);
    vi.advanceTimersByTime(50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ oldValue: false, newValue: true });

    // Falling edge (leak -> dry): min 60s cooldown
    line.emit(1);
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

    // Rising edge: 0ms instant
    line.emit(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ oldValue: false, newValue: true });

    // Falling edge: min 5000ms cooldown
    line.emit(1);
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

    // Emit 31 rapid transitions
    for (let i = 0; i <= 30; i++) {
      line.emit((i % 2) as 0 | 1);
    }

    expect(line.unwatch).toHaveBeenCalled();

    // Now in polled mode (every 10s)
    line.read.mockResolvedValue(0); // level 0 -> true
    vi.advanceTimersByTime(10_000);
    expect(line.read).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('emits a flapping fault event when the circuit breaker engages', async () => {
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init({ ...baseConfig, debounceMs: 0 });

    for (let index = 0; index < 31; index += 1) line.emit((index % 2) as 0 | 1);

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

  it('connects backend when unavailable', async () => {
    backend.isAvailable.mockReturnValue(false);
    await adapter.init(baseConfig);
    expect(backend.connect).toHaveBeenCalledTimes(1);
  });

  it('preserves its connection subscription after an unavailable startup connection', async () => {
    backend.isAvailable.mockReturnValue(false);
    backend.connect.mockRejectedValueOnce(new Error('refused'));
    await expect(adapter.init(baseConfig)).rejects.toThrow(DriverUnavailableError);

    backend.publishState({ available: true, generation: 1 });
    await flushRebind();

    expect(line.configure).toHaveBeenCalledWith({ bias: 'up', debounceUs: 10_000 });
    expect(line.watch).toHaveBeenCalledTimes(1);
  });

  it('restores a fresh GPIO binding once per generation and ignores stale notifications', async () => {
    const lineA = makeFakeLine(1);
    const lineB = makeFakeLine(0);
    backend = makeBackend(lineA);
    backend.line.mockReturnValueOnce(lineA).mockReturnValue(lineB);
    adapter = new DigitalGpioAdapter(backend);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.init({ ...baseConfig, debounceMs: 0 });
    const staleCallback = lineA.watch.mock.calls[0][0];

    backend.publishState({ available: false, generation: 1 });
    backend.publishState({ available: true, generation: 2 });
    await flushRebind();

    expect(lineA.unwatch).toHaveBeenCalledTimes(1);
    expect(lineB.configure).toHaveBeenCalledWith({ bias: 'up', debounceUs: 0 });
    expect(lineB.read).toHaveBeenCalledTimes(1);
    expect(lineB.watch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({ oldValue: false, newValue: true }),
    ]);

    staleCallback(1);
    expect(events).toHaveLength(1);

    const restoredCallback = lineB.watch.mock.calls[0][0];
    restoredCallback(1);
    expect(events).toEqual([
      expect.objectContaining({ oldValue: false, newValue: true }),
      expect.objectContaining({ oldValue: true, newValue: false }),
    ]);

    backend.publishState({ available: true, generation: 2 });
    await flushRebind();
    expect(lineB.watch).toHaveBeenCalledTimes(1);
  });

  it('keeps a restored GPIO binding in polled mode while the flap breaker is active', async () => {
    const lineA = makeFakeLine(1);
    const lineB = makeFakeLine(1);
    backend = makeBackend(lineA);
    backend.line.mockReturnValueOnce(lineA).mockReturnValue(lineB);
    adapter = new DigitalGpioAdapter(backend);
    await adapter.init({ ...baseConfig, debounceMs: 0 });
    const callback = lineA.watch.mock.calls[0][0];

    for (let index = 0; index < 31; index += 1) callback((index % 2) as 0 | 1);
    expect(lineA.unwatch).toHaveBeenCalled();

    backend.publishState({ available: false, generation: 1 });
    backend.publishState({ available: true, generation: 2 });
    await flushRebind();

    expect(lineB.configure).toHaveBeenCalledWith({ bias: 'up', debounceUs: 0 });
    expect(lineB.watch).not.toHaveBeenCalled();
    await adapter.destroy();
  });

  it('ignores a stale polled read after the GPIO binding is restored', async () => {
    vi.useFakeTimers();
    const lineA = makeFakeLine(1);
    const lineB = makeFakeLine(1);
    let resolveStaleRead: ((level: 0 | 1) => void) | undefined;
    backend = makeBackend(lineA);
    backend.line.mockReturnValueOnce(lineA).mockReturnValue(lineB);
    adapter = new DigitalGpioAdapter(backend);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init({ ...baseConfig, debounceMs: 0 });
    const callback = lineA.watch.mock.calls[0][0];

    for (let index = 0; index < 31; index += 1) callback((index % 2) as 0 | 1);
    events.length = 0;
    lineA.read.mockImplementationOnce(
      () => new Promise<0 | 1>((resolve) => {
        resolveStaleRead = resolve;
      }),
    );

    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(resolveStaleRead).toBeTypeOf('function');

    backend.publishState({ available: false, generation: 1 });
    backend.publishState({ available: true, generation: 2 });
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
    const lineA = makeFakeLine(1);
    const lineB = makeFakeLine(1);
    let resolveConfigure: (() => void) | undefined;
    lineB.configure.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveConfigure = resolve;
      }),
    );
    backend = makeBackend(lineA);
    backend.line.mockReturnValueOnce(lineA).mockReturnValue(lineB);
    adapter = new DigitalGpioAdapter(backend);
    await adapter.init(baseConfig);

    backend.publishState({ available: false, generation: 1 });
    backend.publishState({ available: true, generation: 2 });
    await flushRebind();
    expect(lineB.configure).toHaveBeenCalledWith({ bias: 'up', debounceUs: 10_000 });
    const destroy = adapter.destroy();
    expect(backend.unsubscribe).toHaveBeenCalledTimes(1);
    resolveConfigure?.();
    await destroy;
    backend.publishState({ available: true, generation: 3 });
    await flushRebind();

    expect(lineB.watch).not.toHaveBeenCalled();
    expect(lineA.unwatch).toHaveBeenCalledTimes(1);
  });

  it('destroy unregisters watch and clears timers/intervals', async () => {
    await adapter.init(baseConfig);
    await adapter.destroy();
    expect(line.unwatch).toHaveBeenCalled();
  });

  it('unwatches when destroy lands while watch() is in flight', async () => {
    let resolveWatch!: () => void;
    line.watch.mockImplementation(
      () => new Promise<void>((resolveInner) => { resolveWatch = resolveInner; }),
    );
    const initPromise = adapter.init(baseConfig);
    await flushRebind(); // bind has stored the line handle and is awaiting watch()
    const destroyPromise = adapter.destroy();
    resolveWatch();
    await Promise.all([initPromise, destroyPromise]);
    expect(line.unwatch).toHaveBeenCalled();
  });

  it('healthCheck returns true when read succeeds', async () => {
    await adapter.init(baseConfig);
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('healthCheck returns false and stays offline after a read failure', async () => {
    await adapter.init(baseConfig);
    line.read.mockRejectedValue(new Error('socket gone'));
    expect(await adapter.healthCheck()).toBe(false);
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck success after a transient read failure clears offline and re-seeds', async () => {
    vi.useFakeTimers();
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(baseConfig);

    line.read.mockRejectedValueOnce(new Error('monitor down past liveness threshold'));
    await expect(adapter.healthCheck()).resolves.toBe(false); // sets offline

    // While deaf, watch events are dropped — this is the bug class being closed.
    line.emit(0);
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(0);

    // Line recovered; healthCheck read succeeds with a level that changed
    // during the deaf window.
    line.read.mockResolvedValueOnce(0); // active-low: 0 = active
    await expect(adapter.healthCheck()).resolves.toBe(true);
    vi.advanceTimersByTime(100); // baseConfig debounceMs
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'state_change', newValue: true });
  });

  it('healthCheck still reports false while the line stays broken', async () => {
    await adapter.init(baseConfig);
    line.read.mockRejectedValue(new Error('still down'));
    await expect(adapter.healthCheck()).resolves.toBe(false);
    await expect(adapter.healthCheck()).resolves.toBe(false); // no early-return masking
  });

  it('getPin static helper extracts numeric pin', () => {
    expect(DigitalGpioAdapter.getPin({ pin: 17 })).toBe(17);
    expect(DigitalGpioAdapter.getPin({})).toBeNull();
    expect(DigitalGpioAdapter.getPin(null)).toBeNull();
  });

  it('records state change to sensor_logs when repository is provided', async () => {
    const logs = { appendBatch: vi.fn().mockResolvedValue(undefined), findRecent: vi.fn() };
    const loggedAdapter = new DigitalGpioAdapter(backend, logs);
    await loggedAdapter.init({ ...baseConfig, debounceMs: 0 });

    line.emit(0); // activeLow: 0 is active/true

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
    const loggedAdapter = new DigitalGpioAdapter(backend, logs);
    await loggedAdapter.init({ ...baseConfig, debounceMs: 500 });

    line.emit(0); // transition 0 -> active
    vi.advanceTimersByTime(100);
    line.emit(1); // bounce back to 1 while debounce timer is active

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
    const loggedAdapter = new DigitalGpioAdapter(backend, logs);
    await loggedAdapter.init(baseConfig);

    for (let i = 0; i < 35; i++) {
      vi.advanceTimersByTime(1000);
      line.emit((i % 2) as 0 | 1);
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

    // Trip the anti-flap breaker: >30 transitions inside the 60s window.
    for (let i = 0; i < 32; i += 1) line.emit((i % 2) as 0 | 1);
    expect(line.unwatch).toHaveBeenCalled(); // switched to polled mode
    const watchCallsBefore = line.watch.mock.calls.length;

    // Advance past the recovery window; the 10s polled tick performs the check.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000);

    expect(line.watch.mock.calls.length).toBeGreaterThan(watchCallsBefore);
    vi.useRealTimers();
  });
});
