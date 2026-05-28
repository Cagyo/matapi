import { describe, expect, it, vi } from 'vitest';
import { MqttDriver } from '../../../src/sensors/drivers/mqtt.driver';
import { SensorConfig } from '../../../src/sensors/sensor.interface';

const config: SensorConfig = {
  id: 'zigbee_window',
  name: 'Zigbee window',
  type: 'mqtt',
  config: { topic: 'home/window' },
  debounceMs: 5000,
  severity: 'info',
};

describe('MqttDriver', () => {
  it('keeps the phase stub contract explicit', async () => {
    const driver = new MqttDriver();
    driver.onEvent(vi.fn());

    await driver.init(config);

    expect(driver.getState().value).toBe(0);
    await expect(driver.healthCheck()).resolves.toBe(false);
    await expect(driver.destroy()).resolves.toBeUndefined();
  });
});