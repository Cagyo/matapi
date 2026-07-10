import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MqttConfigInvalidError } from '../../../src/sensors/domain/errors/mqtt-config-invalid.error';
import { DEFAULT_MQTT_RECONNECT_MS } from '../../../src/sensors/infrastructure/mqtt.config';

const mockClient = {
  on: vi.fn(),
  endAsync: vi.fn().mockResolvedValue(undefined),
};

vi.mock('mqtt', () => ({ connect: vi.fn(() => mockClient) }));

import { MqttConnectionPool } from '../../../src/sensors/infrastructure/mqtt-connection.pool';

describe('MqttConnectionPool', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockClient.endAsync.mockResolvedValue(undefined);
  });

  it('closes pooled connections through its public destroy operation', async () => {
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    await pool.destroyAll();

    expect(mockClient.endAsync).toHaveBeenCalledWith(true);
  });

  it('owns MQTT.js reconnect and resubscribe policy when creating a connection', async () => {
    const pool = new MqttConnectionPool();

    await pool.acquire('mqtt://localhost:1883', {
      reconnectPeriod: 1_000,
      username: 'sensor-user',
      password: 'sensor-password',
    });

    const mqtt = await import('mqtt');
    expect(mqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
      reconnectPeriod: 1_000,
      connectTimeout: 10_000,
      resubscribe: false,
      reconnectOnConnackError: false,
      username: 'sensor-user',
      password: 'sensor-password',
    });
  });

  it('uses the safe reconnect default when no caller-specific option is supplied', async () => {
    const pool = new MqttConnectionPool();

    await pool.acquire('mqtt://localhost:1883');

    const mqtt = await import('mqtt');
    expect(mqtt.connect).toHaveBeenCalledWith(
      'mqtt://localhost:1883',
      expect.objectContaining({ reconnectPeriod: DEFAULT_MQTT_RECONNECT_MS }),
    );
  });

  it('rejects conflicting pooled reconnect or auth options without leaking credentials', async () => {
    const pool = new MqttConnectionPool();
    const brokerUrl = 'mqtt://broker.example:1883';
    await pool.acquire(brokerUrl, {
      reconnectPeriod: 1_000,
      username: 'first-user',
      password: 'first-password',
    });

    const acquire = pool.acquire(brokerUrl, {
      reconnectPeriod: 5_000,
      username: 'second-user',
      password: 'second-password',
    });

    await expect(acquire).rejects.toThrowError(MqttConfigInvalidError);
    await expect(acquire).rejects.not.toThrow(/first-user|first-password|second-user|second-password/);
  });

  it('shares one destroy operation across concurrent callers', async () => {
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    const first = pool.destroyAll();
    const second = pool.destroyAll();

    expect(second).toBe(first);
    await first;
    expect(mockClient.endAsync).toHaveBeenCalledTimes(1);
  });

  it('bounds a non-settling client close during release', async () => {
    vi.useFakeTimers();
    mockClient.endAsync.mockImplementation(() => new Promise<void>(() => undefined));
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    let settled = false;
    void pool.release('mqtt://localhost:1883').then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(true);
  });

  it('bounds a non-settling client close during pool destruction', async () => {
    vi.useFakeTimers();
    mockClient.endAsync.mockImplementation(() => new Promise<void>(() => undefined));
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    let settled = false;
    void pool.destroyAll().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(true);
  });

  it('does not log raw client error text while closing connections', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const debug = vi.spyOn(Logger.prototype, 'debug');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const brokerUrl = 'mqtt://user:secret@broker.example:1883';
    let onError: ((error: Error) => void) | undefined;
    mockClient.on.mockImplementation((event, listener) => {
      if (event === 'error') onError = listener;
      return mockClient;
    });
    mockClient.endAsync.mockRejectedValue(new Error('raw MQTT close failure password=another-secret'));
    const pool = new MqttConnectionPool();

    await pool.acquire(brokerUrl);
    onError?.(new Error('raw MQTT client failure password=another-secret'));
    await pool.release(brokerUrl);
    await pool.acquire(brokerUrl);
    await pool.destroyAll();

    const messages = [...log.mock.calls, ...debug.mock.calls, ...warn.mock.calls]
      .map(([message]) => String(message));
    expect(messages.join('\n')).not.toContain('raw MQTT client failure');
    expect(messages.join('\n')).not.toContain('raw MQTT close failure');
    expect(messages.join('\n')).not.toContain('another-secret');
    expect(messages.join('\n')).not.toContain('user');
    expect(messages.join('\n')).not.toContain('secret');
  });
});
