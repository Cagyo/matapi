export const SENSOR_HEALTH = Symbol('SENSOR_HEALTH');

/**
 * Live driver health probe — owned by sensors/application. Telegram's
 * `/status` and `/health` handlers depend on this so they never reach
 * into the registry or drivers directly.
 */
export interface SensorHealthPort {
  /** Probe every live driver. Returns a map of sensor id → online flag. */
  probe(): Promise<Map<string, boolean>>;
}
