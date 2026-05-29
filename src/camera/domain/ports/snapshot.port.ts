export const SNAPSHOT = Symbol('SNAPSHOT');

/**
 * Grabs a still frame from a camera (spec 20). The production adapter runs
 * ffmpeg and owns the short-lived TTL cache that prevents concurrent
 * spawns; the use case is unaware of either.
 *
 * Throws `SnapshotFailedError` when capture fails, or
 * `MotionNotRunningError` when the daemon must be running and is not.
 */
export interface SnapshotPort {
  grab(cameraId: string, cameraName: string): Promise<Buffer>;
}
