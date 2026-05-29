export class SensorNotMutedError extends Error {
  readonly code = 'SENSOR_NOT_MUTED' as const;
  constructor(readonly name: string) {
    super(`Sensor '${name}' is not muted`);
    this.name = 'SensorNotMutedError';
  }
}
