import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupUploadUseCase } from '../../../src/camera/application/backup-upload.use-case';
import { DbBackupPort } from '../../../src/camera/domain/ports/db-backup.port';
import { DriveSyncPort } from '../../../src/camera/domain/ports/drive-sync.port';

function fakeBackup(path = '/opt/home-worker/data/backup.db'): DbBackupPort & {
  createLocalBackup: ReturnType<typeof vi.fn>;
} {
  return { createLocalBackup: vi.fn(async () => path) };
}

function fakeDrive(): DriveSyncPort & {
  uploadBackup: ReturnType<typeof vi.fn>;
  pruneBackups: ReturnType<typeof vi.fn>;
} {
  return {
    copyMotionFiles: vi.fn(async () => {}),
    pruneMotionFiles: vi.fn(async () => {}),
    uploadBackup: vi.fn(async () => {}),
    pruneBackups: vi.fn(async () => {}),
  };
}

afterEach(() => {
  delete process.env.BACKUP_TO_GDRIVE;
});

describe('BackupUploadUseCase', () => {
  it('creates a backup, uploads it with a dated name and prunes week-old backups', async () => {
    const backup = fakeBackup('/data/backup.db');
    const drive = fakeDrive();

    await new BackupUploadUseCase(backup, drive).execute();

    expect(backup.createLocalBackup).toHaveBeenCalledOnce();
    const [localPath, remoteName] = drive.uploadBackup.mock.calls[0];
    expect(localPath).toBe('/data/backup.db');
    expect(remoteName).toMatch(/^worker-\d{4}-\d{2}-\d{2}\.db$/);
    expect(drive.pruneBackups).toHaveBeenCalledWith(7);
  });

  it('skips entirely when BACKUP_TO_GDRIVE=false', async () => {
    process.env.BACKUP_TO_GDRIVE = 'false';
    const backup = fakeBackup();
    const drive = fakeDrive();

    await new BackupUploadUseCase(backup, drive).execute();

    expect(backup.createLocalBackup).not.toHaveBeenCalled();
    expect(drive.uploadBackup).not.toHaveBeenCalled();
  });
});
