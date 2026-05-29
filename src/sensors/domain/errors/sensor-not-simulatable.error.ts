/**
 * Raised by the dev simulator when a sensor is either not currently active or
 * its driver does not support simulation (i.e. not a mock adapter). Dev-only.
 */
export class SensorNotSimulatableError extends Error {
  readonly code = 'SENSOR_NOT_SIMULATABLE' as const;
  constructor(readonly sensorId: string) {
    super(`Sensor '${sensorId}' is not active or cannot be simulated`);
    this.name = 'SensorNotSimulatableError';
  }
}
