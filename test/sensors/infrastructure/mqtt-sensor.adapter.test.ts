import { describe, expect, it } from 'vitest';
import { MqttSensorAdapter } from '../../../src/sensors/infrastructure/mqtt-sensor.adapter';
import { SensorConfig } from '../../../src/sensors/domain/sensor';

const config: SensorConfig = {
  id: 'mqtt_1',
  name: 'MQTT 1',
  type: 'mqtt',
  config: {},
  debounceMs: 0,
  severity: 'info',
};

describe('MqttSensorAdapter (stub)', () => {
  it('reports unhealthy', async () => {
    const adapter = new MqttSensorAdapter();
    await adapter.init(config);
    expect(await adapter.healthCheck()).toBe(false);
    await adapter.destroy();
  });
});
