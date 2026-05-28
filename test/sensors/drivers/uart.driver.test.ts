import { describe, expect, it, vi } from 'vitest';
import { UartDriver } from '../../../src/sensors/drivers/uart.driver';
import { SensorConfig } from '../../../src/sensors/sensor.interface';

const config: SensorConfig = {
  id: 'co2_living',
  name: 'CO2 living',
  type: 'uart',
  config: { port: '/dev/ttyS0' },
  debounceMs: 0,
  severity: 'warning',
};

describe('UartDriver', () => {
  it('keeps the phase stub contract explicit', async () => {
    const driver = new UartDriver();
    driver.onEvent(vi.fn());

    await driver.init(config);

    expect(driver.getState().value).toBe(0);
    await expect(driver.healthCheck()).resolves.toBe(false);
    await expect(driver.destroy()).resolves.toBeUndefined();
  });
});