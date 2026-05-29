export const DRIVE_SYNC = Symbol('DRIVE_SYNC');

/**
 * Write side of the Google Drive sync (spec 21). The production adapter shells
 * out to `rclone` (additive `copy`, never `sync`) under `ionice -c3`. All
 * methods throw a typed `Gdrive*` error on failure so the upload loop can
 * record health and alert admins.
 */
export interface DriveSyncPort {
  /**
   * Bulk-copy the local Motion storage tree to the Drive remote. One-way and
   * additive — local deletions are never mirrored to Drive.
   */
  copyMotionFiles(): Promise<void>;
  /** Delete motion files on Drive older than `minAgeDays`. */
  pruneMotionFiles(minAgeDays: number): Promise<void>;
  /** Upload a single local file (DB backup) into the Drive backups folder. */
  uploadBackup(localPath: string, remoteName: string): Promise<void>;
  /** Delete Drive backups older than `minAgeDays`. */
  pruneBackups(minAgeDays: number): Promise<void>;
}
