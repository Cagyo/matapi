import { MqttConfigInvalidError } from '../domain/errors/mqtt-config-invalid.error';
import { mqttConfigIssues } from '../domain/sensor-type-config-validation';

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

  const issues = mqttConfigIssues(raw);
  if (issues.length > 0) {
    throw new MqttConfigInvalidError(issues[0]);
  }

  const brokerUrl =
    typeof raw.brokerUrl === 'string' && raw.brokerUrl.trim().length > 0
      ? raw.brokerUrl.trim()
      : process.env.MQTT_DEFAULT_BROKER_URL || 'mqtt://localhost:1883';

  const topic = (raw.topic as string).trim();

  let qos: 0 | 1 | 2 = 0;
  if (raw.qos !== undefined) {
    qos = raw.qos as 0 | 1 | 2;
  } else if (process.env.MQTT_DEFAULT_QOS) {
    const envQos = Number(process.env.MQTT_DEFAULT_QOS);
    if (envQos === 0 || envQos === 1 || envQos === 2) {
      qos = envQos;
    }
  }

  let format: 'zigbee2mqtt' | 'tasmota' | 'json' | 'auto' = 'auto';
  if (raw.format !== undefined) {
    format = raw.format as typeof format;
  }

  let reconnectMs = 5000;
  if (raw.reconnectMs !== undefined) {
    reconnectMs = raw.reconnectMs as number;
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
