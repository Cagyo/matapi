import { afterEach, describe, expect, it } from 'vitest';
import { MqttConfigInvalidError } from '../../../src/sensors/domain/errors/mqtt-config-invalid.error';
import {
  DEFAULT_MQTT_RECONNECT_MS,
  MAX_MQTT_RECONNECT_MS,
  MIN_MQTT_RECONNECT_MS,
  parseMqttConfig,
} from '../../../src/sensors/infrastructure/mqtt.config';

describe('parseMqttConfig', () => {
  const originalDefaultReconnectMs = process.env.MQTT_DEFAULT_RECONNECT_MS;

  afterEach(() => {
    if (originalDefaultReconnectMs === undefined) {
      delete process.env.MQTT_DEFAULT_RECONNECT_MS;
    } else {
      process.env.MQTT_DEFAULT_RECONNECT_MS = originalDefaultReconnectMs;
    }
  });

  it('exposes the safe reconnect boundaries', () => {
    expect([MIN_MQTT_RECONNECT_MS, DEFAULT_MQTT_RECONNECT_MS, MAX_MQTT_RECONNECT_MS]).toEqual([
      1_000,
      5_000,
      300_000,
    ]);
  });

  it.each([1_000, 5_000, 300_000])(
    'accepts reconnectMs %d within the safe boundary',
    (reconnectMs) => {
      expect(
        parseMqttConfig({
          topic: ' home/front-door ',
          qos: 2,
          format: 'json',
          reconnectMs,
        }),
      ).toMatchObject({
        topic: 'home/front-door',
        qos: 2,
        format: 'json',
        reconnectMs,
      });
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, MAX_MQTT_RECONNECT_MS + 1])(
    'rejects unsafe reconnectMs %s',
    (reconnectMs) => {
      expect(() => parseMqttConfig({ topic: 'home/front-door', reconnectMs })).toThrowError(
        MqttConfigInvalidError,
      );
    },
  );

  it('falls back to the safe default when the environment reconnect value is invalid', () => {
    process.env.MQTT_DEFAULT_RECONNECT_MS = '0';

    expect(
      parseMqttConfig({
        topic: ' home/front-door ',
        qos: 2,
        format: 'json',
      }),
    ).toMatchObject({
      topic: 'home/front-door',
      qos: 2,
      format: 'json',
      reconnectMs: 5_000,
    });
  });
});
