export class SensorAlreadyMutedError extends Error {
  readonly code = 'SENSOR_ALREADY_MUTED' as const;
  constructor(readonly name: string) {
    super(`Sensor '${name}' already muted`);
    this.name = 'SensorAlreadyMutedError';
  }
}
