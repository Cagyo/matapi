export class SensorNotFoundError extends Error {
  readonly code = 'SENSOR_NOT_FOUND' as const;
  constructor(readonly sensorName: string) {
    super(`Sensor '${sensorName}' not found`);
    this.name = 'SensorNotFoundError';
  }
}
