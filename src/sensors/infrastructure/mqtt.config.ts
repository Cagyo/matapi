import { MqttConfigInvalidError } from '../domain/errors/mqtt-config-invalid.error';

export interface MqttSensorConfig {
  brokerUrl: string;
  topic: string;
  valueKey?: string;
  format: 'zigbee2mqtt' | 'tasmota' | 'json' | 'auto';
  username?: string;
  password?: string;
  qos: 0 | 1 | 2;
  reconnectMs: number;
}

export function parseMqttConfig(raw: Record<string, unknown> | null | undefined): MqttSensorConfig {
  if (!raw || typeof raw !== 'object') {
    throw new MqttConfigInvalidError('missing or invalid configuration object');
  }

  const brokerUrl =
    typeof raw.brokerUrl === 'string' && raw.brokerUrl.trim().length > 0
      ? raw.brokerUrl.trim()
      : process.env.MQTT_DEFAULT_BROKER_URL || 'mqtt://localhost:1883';

  const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
  if (!topic) {
    throw new MqttConfigInvalidError('missing required string property "topic"');
  }

  let qos: 0 | 1 | 2 = 0;
  if (raw.qos !== undefined) {
    if (raw.qos === 0 || raw.qos === 1 || raw.qos === 2) {
      qos = raw.qos;
    } else {
      throw new MqttConfigInvalidError(`invalid "qos": ${JSON.stringify(raw.qos)}`);
    }
  } else if (process.env.MQTT_DEFAULT_QOS) {
    const envQos = Number(process.env.MQTT_DEFAULT_QOS);
    if (envQos === 0 || envQos === 1 || envQos === 2) {
      qos = envQos as 0 | 1 | 2;
    }
  }

  let format: 'zigbee2mqtt' | 'tasmota' | 'json' | 'auto' = 'auto';
  if (raw.format !== undefined) {
    if (
      raw.format === 'zigbee2mqtt' ||
      raw.format === 'tasmota' ||
      raw.format === 'json' ||
      raw.format === 'auto'
    ) {
      format = raw.format;
    } else {
      throw new MqttConfigInvalidError(`invalid "format": ${JSON.stringify(raw.format)}`);
    }
  }

  let reconnectMs = 5000;
  if (raw.reconnectMs !== undefined) {
    if (typeof raw.reconnectMs === 'number' && raw.reconnectMs >= 0) {
      reconnectMs = raw.reconnectMs;
    } else {
      throw new MqttConfigInvalidError(`invalid "reconnectMs": ${JSON.stringify(raw.reconnectMs)}`);
    }
  } else if (process.env.MQTT_DEFAULT_RECONNECT_MS) {
    const envReconnect = Number(process.env.MQTT_DEFAULT_RECONNECT_MS);
    if (!isNaN(envReconnect) && envReconnect >= 0) {
      reconnectMs = envReconnect;
    }
  }

  return {
    brokerUrl,
    topic,
    valueKey: typeof raw.valueKey === 'string' ? raw.valueKey : undefined,
    format,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    password: typeof raw.password === 'string' ? raw.password : undefined,
    qos,
    reconnectMs,
  };
}
