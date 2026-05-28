import { describe, expect, it, vi } from 'vitest';
import { CameraDriver } from '../../../src/sensors/drivers/camera.driver';
import { SensorConfig } from '../../../src/sensors/sensor.interface';

const config: SensorConfig = {
  id: 'front_camera',
  name: 'Front camera',
  type: 'camera',
  config: { id: 'cam1' },
  debounceMs: 0,
  severity: 'info',
};

describe('CameraDriver', () => {
  it('keeps the phase stub contract explicit', async () => {
    const driver = new CameraDriver();
    driver.onEvent(vi.fn());

    await driver.init(config);

    expect(driver.getState().value).toBe(0);
    await expect(driver.healthCheck()).resolves.toBe(false);
    await expect(driver.destroy()).resolves.toBeUndefined();
  });
});