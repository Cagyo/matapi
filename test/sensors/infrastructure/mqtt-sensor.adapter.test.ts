import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MqttSensorAdapter } from '../../../src/sensors/infrastructure/mqtt-sensor.adapter';
import { MqttConnectionPool } from '../../../src/sensors/infrastructure/mqtt-connection.pool';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';

class MockMqttClient extends EventEmitter {
  connected = true;
  subscribe = vi.fn((topic, opts, cb) => {
    if (cb) cb(null, [{ topic, qos: 0 }]);
  });
  unsubscribe = vi.fn((topic, cb) => {
    if (cb) cb(null);
  });
  endAsync = vi.fn().mockResolvedValue(undefined);
}

describe('MqttSensorAdapter', () => {
  let pool: MqttConnectionPool;
  let mockClient: MockMqttClient;

  const config: SensorConfig = {
    id: 'mqtt_1',
    name: 'MQTT 1',
    type: 'mqtt',
    config: {
      brokerUrl: 'mqtt://localhost:1883',
      topic: 'zigbee2mqtt/motion',
    },
    debounceMs: 0,
    severity: 'info',
  };

  beforeEach(() => {
    mockClient = new MockMqttClient();
    pool = {
      acquire: vi.fn().mockResolvedValue(mockClient as any),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as MqttConnectionPool;
  });

  afterEach(() => vi.useRealTimers());

  it('initializes and subscribes to topic', async () => {
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);

    expect(pool.acquire).toHaveBeenCalledWith('mqtt://localhost:1883', expect.any(Object));
    expect(mockClient.subscribe).toHaveBeenCalledWith('zigbee2mqtt/motion', { qos: 0 }, expect.any(Function));
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('receives message and emits state_change event', async () => {
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((ev) => events.push(ev));

    await adapter.init(config);

    const payload = Buffer.from(JSON.stringify({ occupancy: true }));
    mockClient.emit('message', 'zigbee2mqtt/motion', payload);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sensorId: 'mqtt_1',
      type: 'state_change',
      newValue: true,
    });
    expect(adapter.getState().value).toBe(true);
  });

  it('deduplicates retained messages with unchanged value', async () => {
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((ev) => events.push(ev));

    await adapter.init(config);

    const payload1 = Buffer.from(JSON.stringify({ occupancy: true }));
    mockClient.emit('message', 'zigbee2mqtt/motion', payload1);
    mockClient.emit('message', 'zigbee2mqtt/motion', payload1);

    expect(events).toHaveLength(1);
  });

  it('drops messages exceeding 64KB', async () => {
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((ev) => events.push(ev));

    await adapter.init(config);

    const hugePayload = Buffer.alloc(65537, 'a');
    mockClient.emit('message', 'zigbee2mqtt/motion', hugePayload);

    expect(events).toHaveLength(0);
  });

  it('unsubscribes and releases client on destroy', async () => {
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);
    await adapter.destroy();

    expect(mockClient.unsubscribe).toHaveBeenCalledWith('zigbee2mqtt/motion', expect.any(Function));
    expect(pool.release).toHaveBeenCalledWith('mqtt://localhost:1883');
  });

  it('releases the client after an unsubscribe callback never arrives', async () => {
    vi.useFakeTimers();
    mockClient.unsubscribe.mockImplementation(() => undefined);
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);

    let settled = false;
    void adapter.destroy().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(pool.release).toHaveBeenCalledWith('mqtt://localhost:1883');
    expect(settled).toBe(true);
  });

  it('does not log raw unsubscribe errors during destroy', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    mockClient.unsubscribe.mockImplementation(() => {
      throw new Error('raw MQTT unsubscribe failure password=another-secret');
    });
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);

    await adapter.destroy();

    expect(warn).toHaveBeenCalledWith('MQTT unsubscribe failed during destroy');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('another-secret'));
  });
});
