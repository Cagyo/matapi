import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockGpioDriver } from '../../../src/sensors/drivers/mock.driver';
import { SensorConfig } from '../../../src/sensors/sensor.interface';

const config: SensorConfig = {
  id: 'front_door',
  name: 'Front door',
  type: 'digital',
  config: { pin: 17 },
  debounceMs: 1000,
  severity: 'info',
};

describe('MockGpioDriver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with a low state and reports healthy', async () => {
    const driver = new MockGpioDriver();

    expect(driver.getState().value).toBe(0);
    await expect(driver.healthCheck()).resolves.toBe(true);
  });

  it('emits state_change events after init when simulateChange is called', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const driver = new MockGpioDriver();
    const listener = vi.fn();
    driver.onEvent(listener);
    await driver.init(config);

    driver.simulateChange(1);

    expect(listener).toHaveBeenCalledWith({
      sensorId: 'front_door',
      type: 'state_change',
      oldValue: 0,
      newValue: 1,
      timestamp: now,
    });
    expect(driver.getState()).toEqual({ value: 1, timestamp: now });
  });

  it('does not emit simulated events before init or after destroy', async () => {
    const driver = new MockGpioDriver();
    const listener = vi.fn();
    driver.onEvent(listener);

    driver.simulateChange(1);
    await driver.init(config);
    await driver.destroy();
    driver.simulateChange(0);

    expect(listener).not.toHaveBeenCalled();
  });
});