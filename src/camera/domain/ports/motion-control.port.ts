export const MOTION_CONTROL = Symbol('MOTION_CONTROL');

/**
 * Controls the Motion daemon lifecycle (spec 20). The production adapter
 * shells out to `systemctl`; handlers and use cases never shell out
 * directly (spec 14 → /camera enable, ../ports-and-adapters.md).
 *
 * `start`/`stop` throw typed domain errors
 * (`MotionAlreadyRunningError`, `MotionStartFailedError`,
 * `MotionNotInstalledError`, `MotionStopFailedError`).
 */
export interface MotionControlPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Restart the daemon (spec 20 — lifecycle watcher). Unlike `start`, it does
   * not throw when the unit is already active. Throws `MotionNotInstalledError`
   * or `MotionStartFailedError` on failure.
   */
  restart(): Promise<void>;
  isActive(): Promise<boolean>;
}
