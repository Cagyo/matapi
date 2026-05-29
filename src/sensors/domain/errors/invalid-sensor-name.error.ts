export class InvalidSensorNameError extends Error {
  readonly code = 'INVALID_SENSOR_NAME' as const;
  constructor(readonly sensorName: string) {
    super(`Invalid sensor name '${sensorName}': use alphanumerics and underscores only`);
    this.name = 'InvalidSensorNameError';
  }
}

const SENSOR_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export function isValidSensorName(name: string): boolean {
  return SENSOR_NAME_PATTERN.test(name);
}
