export class SensorNameExistsError extends Error {
  readonly code = 'SENSOR_NAME_EXISTS' as const;
  constructor(readonly sensorName: string) {
    super(`Sensor '${sensorName}' already exists`);
    this.name = 'SensorNameExistsError';
  }
}
