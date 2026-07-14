export const SENSOR_HEALTH = Symbol('SENSOR_HEALTH');
export const SENSOR_HEALTH_PROBE_TIMEOUT_MS = 5_000;

export type SensorProbeStatus = 'online' | 'offline' | 'missing' | 'failed' | 'timed_out';

export interface SensorProbeResult {
  sensorId: string;
  status: SensorProbeStatus;
}

/**
 * Live driver health probe — owned by sensors/application. Telegram's
 * `/status` and `/health` handlers depend on this so they never reach
 * into the registry or drivers directly.
 */
export interface SensorHealthPort {
  /**
   * Probe the requested live drivers concurrently within each caller's budget.
   * A timeout only releases this caller's waiter; it cannot cancel a driver's
   * third-party I/O unless that driver supports cancellation itself.
   */
  probe(sensorIds: readonly string[], timeoutMs: number): Promise<readonly SensorProbeResult[]>;
}
