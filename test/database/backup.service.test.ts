import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '../../src/database/backup.service';

const tmpRoot = resolve('test/.tmp/backup-service');
const originalBackupPath = process.env.BACKUP_LOCAL_PATH;

describe('BackupService', () => {
  afterEach(() => {
    if (originalBackupPath === undefined) {
      delete process.env.BACKUP_LOCAL_PATH;
    } else {
      process.env.BACKUP_LOCAL_PATH = originalBackupPath;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates the target directory and delegates to sqlite backup', async () => {
    const target = resolve(tmpRoot, 'nested', 'backup.db');
    process.env.BACKUP_LOCAL_PATH = target;
    const sqlite = {
      backup: vi.fn().mockResolvedValue(undefined),
    } as unknown as Database.Database;
    const service = new BackupService(sqlite);

    await expect(service.run()).resolves.toBe(target);

    expect(sqlite.backup).toHaveBeenCalledWith(target);
    expect(existsSync(dirname(target))).toBe(true);
  });
});