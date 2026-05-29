export const LOCAL_STORAGE = Symbol('LOCAL_STORAGE');

/**
 * Mutating filesystem operations over the local Motion storage directory
 * (`MOTION_LOCAL_DIR`), used by the cleanup loop (spec 21). Distinct from the
 * read-only `MediaFilePort`. The production adapter uses `df` for usage and
 * `fs` for deletions; every method degrades safely on error.
 */
export interface LocalStoragePort {
  /** Disk usage of the filesystem holding the Motion dir, as a 0–100 percent. */
  usagePercent(): Promise<number>;
  /** Delete a single file. No-op when the path is missing. */
  deleteFile(path: string): Promise<void>;
  /** Remove now-empty `YYYY/MM/DD` day-directories under the Motion dir. */
  pruneEmptyDirs(): Promise<void>;
}
