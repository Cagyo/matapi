import { Logger } from '@nestjs/common';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteWithIntegrity } from '../../src/database/integrity';

const tmpRoot = resolve('test/.tmp/integrity');
const logger = new Logger('IntegrityTest');
const originalBackupPath = process.env.BACKUP_LOCAL_PATH;

function restoreEnv(): void {
  if (originalBackupPath === undefined) {
    delete process.env.BACKUP_LOCAL_PATH;
  } else {
    process.env.BACKUP_LOCAL_PATH = originalBackupPath;
  }
}

describe('openSqliteWithIntegrity', () => {
  afterEach(() => {
    restoreEnv();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('opens a healthy database with no recovery', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const dbPath = resolve(tmpRoot, 'app.db');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t (id) VALUES (1);');
    seed.close();

    const { sqlite, recovery } = openSqliteWithIntegrity(dbPath, logger);

    expect(recovery).toBeNull();
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    sqlite.close();
  });

  it('restores from the local backup when the database is corrupt', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const dbPath = resolve(tmpRoot, 'app.db');
    const backupPath = resolve(tmpRoot, 'backup.db');
    process.env.BACKUP_LOCAL_PATH = backupPath;

    const backup = new Database(backupPath);
    backup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t (id) VALUES (42);');
    backup.close();

    // Write garbage where the database should be.
    writeFileSync(dbPath, 'this is not a sqlite database');

    const { sqlite, recovery } = openSqliteWithIntegrity(dbPath, logger);

    expect(recovery).toBe('restored_from_backup');
    const row = sqlite.prepare('SELECT id FROM t').get() as { id: number };
    expect(row.id).toBe(42);
    sqlite.close();
  });

  it('recreates an empty database when corrupt and no backup exists', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const dbPath = resolve(tmpRoot, 'app.db');
    process.env.BACKUP_LOCAL_PATH = resolve(tmpRoot, 'missing-backup.db');
    writeFileSync(dbPath, 'corrupt');

    const { sqlite, recovery } = openSqliteWithIntegrity(dbPath, logger);

    expect(recovery).toBe('recreated_empty');
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    expect(tables).toEqual([]);
    sqlite.close();
  });
});
