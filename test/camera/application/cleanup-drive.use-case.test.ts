import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupDriveUseCase } from '../../../src/camera/application/cleanup-drive.use-case';
import { DriveQuota, DriveStatusPort } from '../../../src/camera/domain/ports/drive-status.port';
import { DriveSyncPort } from '../../../src/camera/domain/ports/drive-sync.port';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

function quota(usedFraction: number): DriveQuota {
  const total = 15 * 1024 ** 3;
  const used = Math.round(total * usedFraction);
  return { totalBytes: total, usedBytes: used, freeBytes: total - used };
}

function status(usedFraction: number): DriveStatusPort {
  return { about: async () => quota(usedFraction) };
}

function fakeDrive(): DriveSyncPort & { pruneMotionFiles: ReturnType<typeof vi.fn> } {
  return {
    copyMotionFiles: vi.fn(async () => {}),
    pruneMotionFiles: vi.fn(async () => {}),
    uploadBackup: vi.fn(async () => {}),
    pruneBackups: vi.fn(async () => {}),
  };
}

function fakeMeta(val: string | null = null): SystemMetaRepositoryPort {
  return {
    get: vi.fn(async () => val),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function oldUploaded(id: number, ageDays: number): MotionEvent {
  const at = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  return {
    id,
    cameraId: 'front_door',
    startedAt: at,
    endedAt: at,
    videoPath: `/var/lib/motion/${id}.mp4`,
    snapshotPath: null,
    uploadedToGdrive: true,
    gdriveFileId: `home-security/motion/${id}.mp4`,
    localDeleted: true,
  };
}

afterEach(() => {
  delete process.env.GDRIVE_CLEANUP_PERCENT;
  delete process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS;
});

describe('CleanupDriveUseCase', () => {
  it('does nothing below the cleanup threshold', async () => {
    const drive = fakeDrive();
    const repo = new InMemoryMediaRepository();

    const res = await new CleanupDriveUseCase(
      status(0.5),
      drive,
      repo,
      fakeMeta(),
    ).execute();

    expect(res).toEqual({ thresholdUsed: 80 });
    expect(drive.pruneMotionFiles).not.toHaveBeenCalled();
  });

  it('prunes old Drive files and clears their gdrive reference when full', async () => {
    process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS = '30';
    const drive = fakeDrive();
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([oldUploaded(1, 40), oldUploaded(2, 5)]);

    const res = await new CleanupDriveUseCase(
      status(0.9),
      drive,
      repo,
      fakeMeta(),
    ).execute();

    expect(res).toEqual({ thresholdUsed: 80 });
    expect(drive.pruneMotionFiles).toHaveBeenCalledWith(30);
    // event 1 (40d) was cleared by the use-case; only event 2 (5d) still has a
    // reference, so a now-cutoff sweep clears exactly one more.
    const cleared = await repo.clearGdriveForEventsOlderThan(new Date());
    expect(cleared).toBe(1);
  });

  it('uses auto_clean_threshold from metadata repository', async () => {
    const drive = fakeDrive();
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([oldUploaded(1, 40)]);

    // With auto_clean_threshold = 70, 75% usage should trigger cleanup
    const res = await new CleanupDriveUseCase(
      status(0.75),
      drive,
      repo,
      fakeMeta('70'),
    ).execute();

    expect(res).toEqual({ thresholdUsed: 70 });
    expect(drive.pruneMotionFiles).toHaveBeenCalled();
  });

  it('uses custom override threshold when provided', async () => {
    const drive = fakeDrive();
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([oldUploaded(1, 40)]);

    // Override threshold = 60, should trigger cleanup when usage is 65%
    const res = await new CleanupDriveUseCase(
      status(0.65),
      drive,
      repo,
      fakeMeta('80'),
    ).execute(60);

    expect(res).toEqual({ thresholdUsed: 60 });
    expect(drive.pruneMotionFiles).toHaveBeenCalled();
  });
});
