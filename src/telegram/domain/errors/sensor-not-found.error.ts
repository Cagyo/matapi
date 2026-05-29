export class SensorNotFoundError extends Error {
  readonly code = 'SENSOR_NOT_FOUND' as const;
  constructor(readonly name: string) {
    super(`Sensor '${name}' not found`);
    this.name = 'SensorNotFoundError';
  }
}
