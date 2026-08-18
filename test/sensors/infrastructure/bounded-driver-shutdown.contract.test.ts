import { describe, expect, it, vi } from 'vitest';
import { BaseUartCo2Adapter, Co2Source, UartCo2Defaults } from '../../../src/sensors/infrastructure/base-uart-co2.adapter';
import { CameraSensorAdapter } from '../../../src/sensors/infrastructure/camera-sensor.adapter';
import { DigitalGpioAdapter } from '../../../src/sensors/infrastructure/digital-gpio.adapter';
import {
  GpioBackendPort,
  GpioBackendState,
  GpioLine,
} from '../../../src/sensors/infrastructure/gpio-backend.port';
import { SensorConfig } from '../../../src/sensors/domain/sensor';

const digitalConfig: SensorConfig = {
  id: 'front_door',
  name: 'Front door',
  type: 'digital',
  config: { pin: 17, activeLow: true, pull: 'up' },
  debounceMs: 100,
  severity: 'warning',
};

const uartConfig: SensorConfig = {
  id: 'living_co2',
  name: 'Living CO2',
  type: 'co2',
  config: { port: '/dev/ttyS0' },
  debounceMs: 0,
  severity: 'warning',
};

function deadlineContext(signal: AbortSignal) {
  return { signal, deadlineAt: Date.now() + 60_000 };
}

async function settlesBeforeNextTurn(operation: Promise<void>): Promise<'done' | 'pending'> {
  return Promise.race([
    operation.then(() => 'done' as const),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
}

class HangingCloseSource implements Co2Source {
  close = vi.fn(() => new Promise<void>(() => undefined));

  open(): Promise<void> {
    return Promise.resolve();
  }
  async read(): Promise<number | null> {
    return null;
  }
  isOpen(): boolean {
    return true;
  }
}

class TestUartAdapter extends BaseUartCo2Adapter {
  protected defaults(): UartCo2Defaults {
    return {
      warning: 800,
      critical: 1200,
      readIntervalMs: 60_000,
      flushIntervalMs: 60_000,
      baudRate: 9600,
    };
  }
}

describe('bounded SensorDriver shutdown contract', () => {
  it('makes GPIO inert and completes after cancellation when endNotify hangs', async () => {
    const line: GpioLine = {
      configure: vi.fn().mockResolvedValue(undefined),
      read: vi.fn(async (): Promise<0 | 1> => 1),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const unsubscribe = vi.fn();
    const backend: GpioBackendPort = {
      connect: vi.fn().mockResolvedValue(undefined),
      isAvailable: vi.fn(() => true),
      state: vi.fn((): GpioBackendState => ({ available: true, generation: 1 })),
      onStateChange: vi.fn(() => unsubscribe),
      line: vi.fn(() => line),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new DigitalGpioAdapter(backend);
    await adapter.init(digitalConfig);
    const controller = new AbortController();

    const destroy = adapter.destroy(deadlineContext(controller.signal));
    controller.abort();

    await expect(settlesBeforeNextTurn(destroy)).resolves.toBe('done');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('completes after cancellation when a GPIO rebind is still hanging', async () => {
    const firstLine: GpioLine = {
      configure: vi.fn().mockResolvedValue(undefined),
      read: vi.fn(async (): Promise<0 | 1> => 1),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
    };
    const secondLine: GpioLine = {
      ...firstLine,
      configure: vi.fn(() => new Promise<void>(() => undefined)),
    };
    let onStateChange: ((state: GpioBackendState) => void) | undefined;
    const backend: GpioBackendPort = {
      connect: vi.fn().mockResolvedValue(undefined),
      isAvailable: vi.fn(() => true),
      state: vi.fn((): GpioBackendState => ({ available: true, generation: 1 })),
      onStateChange: vi.fn((listener: (state: GpioBackendState) => void) => {
        onStateChange = listener;
        return vi.fn();
      }),
      line: vi.fn().mockReturnValueOnce(firstLine).mockReturnValue(secondLine),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new DigitalGpioAdapter(backend);
    await adapter.init(digitalConfig);
    onStateChange?.({ available: false, generation: 1 });
    onStateChange?.({ available: true, generation: 2 });
    await Promise.resolve();
    const controller = new AbortController();

    const destroy = adapter.destroy(deadlineContext(controller.signal));
    controller.abort();

    await expect(settlesBeforeNextTurn(destroy)).resolves.toBe('done');
  });

  it('makes UART inert and completes after cancellation when source close hangs', async () => {
    const source = new HangingCloseSource();
    const logs = { appendBatch: vi.fn().mockResolvedValue(undefined) };
    const adapter = new TestUartAdapter(source, logs, TestUartAdapter.name);
    await adapter.init(uartConfig);
    const controller = new AbortController();

    const destroy = adapter.destroy(deadlineContext(controller.signal));
    controller.abort();

    await expect(settlesBeforeNextTurn(destroy)).resolves.toBe('done');
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('makes camera inert and completes after cancellation when backend destroy hangs', async () => {
    const adapter = new CameraSensorAdapter();
    const destroyBackend = vi.fn(() => new Promise<void>(() => undefined));
    (adapter as unknown as { backend: { destroy: () => Promise<void> } }).backend = {
      destroy: destroyBackend,
    };
    const controller = new AbortController();

    const destroy = adapter.destroy(deadlineContext(controller.signal));
    controller.abort();

    await expect(settlesBeforeNextTurn(destroy)).resolves.toBe('done');
    expect(destroyBackend).toHaveBeenCalledTimes(1);
  });
});
