import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '../../src/database/backup.service';

const tmpRoot = resolve('test/.tmp/backup-service');
const originalBackupPath = process.env.BACKUP_LOCAL_PATH;

describe('BackupService', () => {
  afterEach(() => {
    if (originalBackupPath === undefined) delete process.env.BACKUP_LOCAL_PATH;
    else process.env.BACKUP_LOCAL_PATH = originalBackupPath;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes the backup atomically via a temp file then rename', async () => {
    const target = resolve(tmpRoot, 'nested', 'backup.db');
    process.env.BACKUP_LOCAL_PATH = target;

    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (7);');
    const service = new BackupService(sqlite);

    await expect(service.run()).resolves.toBe(target);

    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.tmp`)).toBe(false); // temp cleaned by rename
    const restored = new Database(target);
    expect((restored.prepare('SELECT id FROM t').get() as { id: number }).id).toBe(7);
    restored.close();
    sqlite.close();
  });

  it('keeps the previous backup intact and removes the temp file when backup fails', async () => {
    const target = resolve(tmpRoot, 'backup.db');
    process.env.BACKUP_LOCAL_PATH = target;
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(target, 'previous good backup');

    // backup() writes a partial temp file then throws mid-write. The catch must
    // clean up that temp and rethrow, leaving the last good backup at `target`
    // untouched — the crash-safety guarantee that a non-atomic write violates.
    const sqlite = {
      backup: vi.fn().mockImplementation(async (tmpPath: string) => {
        writeFileSync(tmpPath, 'partial write');
        throw new Error('backup failed mid-write');
      }),
    } as unknown as Database.Database;
    const service = new BackupService(sqlite);

    await expect(service.run()).rejects.toThrow('backup failed mid-write');

    expect(existsSync(`${target}.tmp`)).toBe(false); // partial temp removed
    expect(readFileSync(target, 'utf8')).toBe('previous good backup'); // untouched
  });
});
