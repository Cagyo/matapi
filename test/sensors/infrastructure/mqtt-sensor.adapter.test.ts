import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MqttSensorAdapter } from '../../../src/sensors/infrastructure/mqtt-sensor.adapter';
import { MqttConnectionPool } from '../../../src/sensors/infrastructure/mqtt-connection.pool';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';
import { en } from '../../../src/locales/en';
import * as mqtt from 'mqtt';

vi.mock('mqtt', () => ({ connect: vi.fn() }));

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

  it('subscribes exactly once for each connect event', async () => {
    mockClient.connected = false;
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);

    expect(mockClient.subscribe).not.toHaveBeenCalled();

    mockClient.emit('connect');
    expect(mockClient.subscribe).toHaveBeenCalledTimes(1);

    mockClient.emit('connect');
    expect(mockClient.subscribe).toHaveBeenCalledTimes(2);
  });

  it('emits nothing before a continuous MQTT outage reaches the alert threshold', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(config);

    mockClient.emit('offline');
    await vi.advanceTimersByTimeAsync(59_999);

    expect(events).toEqual([]);
  });

  it('emits one localized error when a continuous MQTT outage reaches the alert threshold', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(config);

    mockClient.emit('offline');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events).toEqual([
      expect.objectContaining({
        sensorId: 'mqtt_1',
        type: 'error',
        newValue: en.sensors.notifications.mqttOffline,
      }),
    ]);
  });

  it('deduplicates offline and close events into one delayed MQTT outage event', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(config);

    mockClient.emit('offline');
    mockClient.emit('close');
    mockClient.emit('offline');

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', newValue: en.sensors.notifications.mqttOffline });
  });

  it('emits one recovery after a prolonged MQTT outage and resubscribes once', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(config);

    mockClient.emit('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    mockClient.connected = true;
    mockClient.emit('connect');

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', newValue: en.sensors.notifications.mqttOffline }),
      expect.objectContaining({ type: 'error', newValue: en.sensors.notifications.mqttRecovered }),
    ]);
    expect(mockClient.subscribe).toHaveBeenCalledTimes(2);
  });

  it('does not emit recovery after a transient MQTT outage', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(config);

    mockClient.emit('offline');
    await vi.advanceTimersByTimeAsync(59_999);
    mockClient.connected = true;
    mockClient.emit('connect');

    expect(events).toEqual([]);
    expect(mockClient.subscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not emit recovery on later connects without a new prolonged outage', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    const events: SensorEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.init(config);

    mockClient.emit('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    mockClient.emit('connect');
    mockClient.emit('connect');

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'error', newValue: en.sensors.notifications.mqttRecovered });
    expect(mockClient.subscribe).toHaveBeenCalledTimes(3);
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

  it('cancels the outage timer and removes all MQTT listeners on destroy', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);
    mockClient.emit('offline');

    expect(mockClient.listenerCount('message')).toBe(1);
    expect(mockClient.listenerCount('connect')).toBe(1);
    expect(mockClient.listenerCount('offline')).toBe(1);
    expect(mockClient.listenerCount('close')).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await adapter.destroy();

    expect(mockClient.listenerCount('message')).toBe(0);
    expect(mockClient.listenerCount('connect')).toBe(0);
    expect(mockClient.listenerCount('offline')).toBe(0);
    expect(mockClient.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the pool immediately without unsubscribe when destroyed while disconnected', async () => {
    vi.useFakeTimers();
    mockClient.connected = false;
    mockClient.unsubscribe.mockImplementation(() => undefined);
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);

    await adapter.destroy();

    expect(mockClient.unsubscribe).not.toHaveBeenCalled();
    expect(pool.release).toHaveBeenCalledWith('mqtt://localhost:1883');
    expect(vi.getTimerCount()).toBe(0);
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

  it('defers a last-reference client end until lifecycle shutdown after adapter destruction', async () => {
    vi.mocked(mqtt.connect).mockReturnValue(mockClient as never);
    const realPool = new MqttConnectionPool();
    const adapter = new MqttSensorAdapter(realPool);
    await adapter.init(config);

    realPool.beginLifecycleShutdown();
    await adapter.destroy();

    expect(mockClient.endAsync).not.toHaveBeenCalled();
    await realPool.destroyAll();
    expect(mockClient.endAsync).toHaveBeenCalledWith(true);
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

  it('does not leave a health-check timeout behind', async () => {
    vi.useFakeTimers();
    const adapter = new MqttSensorAdapter(pool);
    await adapter.init(config);

    expect(await adapter.healthCheck()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
