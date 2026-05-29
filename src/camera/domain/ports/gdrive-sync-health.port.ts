export const GDRIVE_SYNC_HEALTH = Symbol('GDRIVE_SYNC_HEALTH');

/** Rolling health of the rclone upload loop (specs 15, 21). */
export interface GdriveSyncHealthSnapshot {
  /** Consecutive failed upload cycles; reset to 0 on first success. */
  consecutiveFailures: number;
  /** Last upload error message, or `null` when healthy. */
  lastError: string | null;
  /** Last successful upload time, or `null` if none yet. */
  lastSuccessAt: Date | null;
}

/**
 * In-process health record for the Drive sync loop. The (future) upload
 * service records outcomes here; `/gdrive status` reads the snapshot. Kept
 * as a port so the bot layer never reaches into the upload internals.
 */
export interface GdriveSyncHealthPort {
  snapshot(): GdriveSyncHealthSnapshot;
  recordSuccess(at: Date): void;
  recordFailure(error: string): void;
}
