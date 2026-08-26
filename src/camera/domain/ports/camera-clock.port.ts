export const CAMERA_CLOCK = Symbol('CAMERA_CLOCK');

/**
 * Wall-clock reader for camera attestations — distinct from `MONOTONIC_CLOCK`,
 * which measures elapsed time and cannot be stored.
 *
 * Synchronous by contract: `verifiedAt` is stamped inside the fence that guards
 * a source commit, where no `await` is permitted.
 */
export interface CameraClockPort {
  now(): Date;
}
