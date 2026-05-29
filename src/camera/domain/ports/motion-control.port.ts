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
  isActive(): Promise<boolean>;
}
