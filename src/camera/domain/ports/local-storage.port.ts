export const LOCAL_STORAGE = Symbol('LOCAL_STORAGE');

export interface LocalFileInfo {
  path: string;
  /** File mtime in ms since epoch; rclone --min-age uses this. */
  mtimeMs: number;
  /** File ctime in ms since epoch; guards against newly restored old-mtime files. */
  ctimeMs: number;
}

/**
 * Mutating filesystem operations over the local Motion storage directory
 * (`MOTION_LOCAL_DIR`), used by the cleanup loop (spec 21). Distinct from the
 * read-only `MediaFilePort`. The production adapter uses `df` for usage and
 * `fs` for deletions; every method degrades safely on error.
 */
export interface LocalStoragePort {
  /** Disk usage of the filesystem holding the Motion dir, as a 0–100 percent. */
  usagePercent(): Promise<number>;

  /**
   * Delete a single file. Returns true when the file was removed or was already
   * absent; false when deletion failed. Callers must not mark DB rows
   * local-deleted after false.
   */
  deleteFile(path: string): Promise<boolean>;

  /** Remove now-empty `YYYY/MM/DD` day-directories under the Motion dir. */
  pruneEmptyDirs(): Promise<void>;

  /**
   * Regular files under the Motion dir whose mtime is older than `cutoff`.
   * Empty list on any error (safe default: nothing to sweep).
   */
  listFilesOlderThan(cutoff: Date): Promise<LocalFileInfo[]>;
}
