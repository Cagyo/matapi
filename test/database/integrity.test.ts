import { Logger } from '@nestjs/common';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('recreates an empty database when the backup itself is corrupt', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const dbPath = resolve(tmpRoot, 'app.db');
    const backupPath = resolve(tmpRoot, 'backup.db');
    process.env.BACKUP_LOCAL_PATH = backupPath;

    writeFileSync(backupPath, 'this backup is also garbage');
    writeFileSync(dbPath, 'corrupt live db');

    const { sqlite, recovery } = openSqliteWithIntegrity(dbPath, logger);

    expect(recovery).toBe('recreated_empty');
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    expect(tables).toEqual([]);
    sqlite.close();
  });

  it('recreates empty when the restored backup opens but fails integrity_check', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const dbPath = resolve(tmpRoot, 'app.db');
    const backupPath = resolve(tmpRoot, 'backup.db');
    process.env.BACKUP_LOCAL_PATH = backupPath;

    // A backup that is a *valid, openable* SQLite file but internally
    // inconsistent — the kind of silent damage a non-atomic backup (#8) can
    // leave behind. Build it, then flip one byte deep inside a b-tree page so
    // the file still opens yet integrity_check reports the index is broken.
    const seed = new Database(backupPath);
    seed.pragma('journal_mode = DELETE');
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX i ON t(v);');
    const insert = seed.prepare('INSERT INTO t (v) VALUES (?)');
    const seedRows = seed.transaction(() => {
      for (let i = 0; i < 300; i++) insert.run('val' + String(i).padStart(4, '0'));
    });
    seedRows();
    seed.close();

    const buf = readFileSync(backupPath);
    const pageSize = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
    buf[pageSize * 3 + Math.floor(pageSize * 0.75)] ^= 0xff; // corrupt an index page
    writeFileSync(backupPath, buf);

    writeFileSync(dbPath, 'corrupt live db'); // force the recover() path

    const { sqlite, recovery } = openSqliteWithIntegrity(dbPath, logger);

    // The backup opens cleanly but fails integrity_check, so it must be rejected
    // and an empty DB recreated — not accepted as `restored_from_backup`.
    expect(recovery).toBe('recreated_empty');
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    expect(tables).toEqual([]);
    sqlite.close();
  });
});
