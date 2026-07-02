export class MqttConfigInvalidError extends Error {
  readonly code = 'MQTT_CONFIG_INVALID' as const;
  constructor(readonly reason: string) {
    super(`MQTT sensor config invalid: ${reason}`);
    this.name = 'MqttConfigInvalidError';
  }
}
