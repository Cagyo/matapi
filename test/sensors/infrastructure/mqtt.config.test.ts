import { describe, expect, it } from 'vitest';
import { MqttConfigInvalidError } from '../../../src/sensors/domain/errors/mqtt-config-invalid.error';
import { mqttConfigIssues } from '../../../src/sensors/domain/sensor-type-config-validation';
import { parseMqttConfig } from '../../../src/sensors/infrastructure/mqtt.config';

describe('parseMqttConfig', () => {
  it('normalizes a valid MQTT topic and preserves a zero reconnect delay', () => {
    expect(
      parseMqttConfig({
        topic: ' home/front-door ',
        qos: 2,
        format: 'json',
        reconnectMs: 0,
      }),
    ).toMatchObject({
      topic: 'home/front-door',
      qos: 2,
      format: 'json',
      reconnectMs: 0,
    });
  });

  it('uses the first shared issue in its typed error', () => {
    const raw = { topic: 'home/front-door', reconnectMs: 1.5 };
    const [issue] = mqttConfigIssues(raw);

    expect(() => parseMqttConfig(raw)).toThrowError(MqttConfigInvalidError);
    expect(() => parseMqttConfig(raw)).toThrow(issue);
  });
});
