import { describe, expect, it } from 'vitest';
import { CameraSensorAdapter } from '../../../src/sensors/infrastructure/camera-sensor.adapter';
import { SensorConfig } from '../../../src/sensors/domain/sensor';

const config: SensorConfig = {
  id: 'cam_1',
  name: 'Camera 1',
  type: 'camera',
  config: {},
  debounceMs: 0,
  severity: 'info',
};

describe('CameraSensorAdapter (stub)', () => {
  it('reports unhealthy', async () => {
    const adapter = new CameraSensorAdapter();
    await adapter.init(config);
    expect(await adapter.healthCheck()).toBe(false);
    await adapter.destroy();
  });
});
