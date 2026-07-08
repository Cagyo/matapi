import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Outcome of the boot-time integrity check (spec 23 — Boot Recovery / SQLite
 * Corruption). `null` means the database opened cleanly.
 */
export type DbRecovery = 'restored_from_backup' | 'recreated_empty' | null;

export interface OpenResult {
  sqlite: Database.Database;
  recovery: DbRecovery;
}

function openWithPragmas(dbPath: string): Database.Database {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

function isHealthy(sqlite: Database.Database): boolean {
  const rows = sqlite.pragma('integrity_check') as { integrity_check: string }[];
  return rows.length === 1 && rows[0]?.integrity_check === 'ok';
}

/** Remove a SQLite database file along with its WAL/SHM sidecars. */
function removeDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // best-effort — a missing sidecar is fine
    }
  }
}

/**
 * Replace a corrupt database with the local backup if one exists, otherwise
 * clear the files so a fresh schema is created by the subsequent migration.
 */
function recover(dbPath: string, logger: Logger): DbRecovery {
  const backupPath = resolve(process.env.BACKUP_LOCAL_PATH || './data/backup.db');
  removeDatabaseFiles(dbPath);

  if (existsSync(backupPath)) {
    copyFileSync(backupPath, dbPath);
    logger.warn(`Restored database from backup ${backupPath}`);
    return 'restored_from_backup';
  }

  logger.warn('No local backup found — starting with a fresh database');
  return 'recreated_empty';
}

/**
 * Open the SQLite database, verifying integrity first (spec 23). On corruption
 * the file is replaced from the local backup (or recreated empty) and reopened.
 * The recovery outcome is surfaced so the boot notification can warn admins.
 */
export function openSqliteWithIntegrity(dbPath: string, logger: Logger): OpenResult {
  mkdirSync(dirname(dbPath), { recursive: true });

  try {
    const sqlite = openWithPragmas(dbPath);
    if (isHealthy(sqlite)) {
      return { sqlite, recovery: null };
    }
    logger.error('SQLite integrity_check failed — attempting recovery');
    sqlite.close();
  } catch (err) {
    logger.error(`SQLite open/integrity check failed: ${(err as Error).message}`);
  }

  const recovery = recover(dbPath, logger);

  // A restored backup must itself pass integrity_check; a corrupt backup must
  // never silently become the live database (spec 23).
  let restored: Database.Database | undefined;
  try {
    restored = openWithPragmas(dbPath);
    if (recovery !== 'restored_from_backup' || isHealthy(restored)) {
      return { sqlite: restored, recovery };
    }
    logger.error('Restored backup failed integrity_check — recreating empty');
  } catch (err) {
    logger.error(`Restored backup could not be opened: ${(err as Error).message}`);
  }
  // Close the reopened handle on every non-return path — including isHealthy()
  // throwing on a garbage backup — before clearing the files, so a failed
  // restore never leaks a handle to an unlinked database file.
  restored?.close();

  removeDatabaseFiles(dbPath);
  return { sqlite: openWithPragmas(dbPath), recovery: 'recreated_empty' };
}
