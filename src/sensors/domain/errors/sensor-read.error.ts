export class SensorReadError extends Error {
  readonly code = 'SENSOR_READ' as const;
  constructor(
    readonly sensorId: string,
    readonly reason: string,
  ) {
    super(`Sensor '${sensorId}' read failed: ${reason}`);
    this.name = 'SensorReadError';
  }
}
