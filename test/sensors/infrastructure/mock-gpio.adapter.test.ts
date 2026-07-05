import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockGpioAdapter } from '../../../src/sensors/infrastructure/mock-gpio.adapter';
import { SensorConfig } from '../../../src/sensors/domain/sensor';

const config: SensorConfig = {
  id: 'front_door',
  name: 'Front door',
  type: 'digital',
  config: { pin: 17 },
  debounceMs: 1000,
  severity: 'info',
};

describe('MockGpioAdapter', () => {
  afterEach(() => vi.useRealTimers());

  it('starts low and reports healthy', async () => {
    const adapter = new MockGpioAdapter();
    expect(adapter.getState().value).toBe(0);
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('emits state_change after init when simulateChange is called', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const adapter = new MockGpioAdapter();
    const listener = vi.fn();
    adapter.onEvent(listener);
    await adapter.init(config);

    adapter.simulateChange(1);

    expect(listener).toHaveBeenCalledWith({
      sensorId: 'front_door',
      type: 'state_change',
      oldValue: 0,
      newValue: 1,
      timestamp: now,
    });
    expect(adapter.getState()).toEqual({ value: 1, timestamp: now });
  });

  it('does not emit before init or after destroy', async () => {
    const adapter = new MockGpioAdapter();
    const listener = vi.fn();
    adapter.onEvent(listener);

    adapter.simulateChange(1);
    await adapter.init(config);
    await adapter.destroy();
    adapter.simulateChange(0);

    expect(listener).not.toHaveBeenCalled();
  });

  it('records state changes to sensor_logs when repository is provided', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const logs = { appendBatch: vi.fn().mockResolvedValue(undefined), findRecent: vi.fn() };
    const adapter = new MockGpioAdapter(logs);
    await adapter.init(config);

    adapter.simulateChange(1);

    expect(logs.appendBatch).toHaveBeenCalledWith([
      {
        sensorId: 'front_door',
        level: 'info',
        message: 'State changed: CLOSED → OPEN',
        timestamp: now,
      },
    ]);
  });
});
