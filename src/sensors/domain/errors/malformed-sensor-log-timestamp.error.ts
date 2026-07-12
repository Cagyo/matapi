export class MalformedSensorLogTimestampError extends Error {
  readonly code = 'MALFORMED_SENSOR_LOG_TIMESTAMP' as const;

  constructor(readonly sensorId: string) {
    super(`Selected sensor log for '${sensorId}' has no timestamp`);
    this.name = 'MalformedSensorLogTimestampError';
  }
}
