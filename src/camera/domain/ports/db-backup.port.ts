export const DB_BACKUP = Symbol('DB_BACKUP');

/**
 * Produces a consistent local SQLite backup for the daily Drive upload
 * (spec 21). The production adapter uses the SQLite Online Backup API so it
 * does not block concurrent reads/writes.
 */
export interface DbBackupPort {
  /** Write a fresh backup to `BACKUP_LOCAL_PATH` and return its absolute path. */
  createLocalBackup(): Promise<string>;
}
