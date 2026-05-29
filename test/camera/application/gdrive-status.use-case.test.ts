import { afterEach, describe, expect, it } from 'vitest';
import { GdriveStatusUseCase } from '../../../src/camera/application/gdrive-status.use-case';
import { DriveQuota, DriveStatusPort } from '../../../src/camera/domain/ports/drive-status.port';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { InMemoryGdriveSyncHealth } from '../../../src/camera/infrastructure/in-memory-gdrive-sync-health';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

const QUOTA: DriveQuota = {
  totalBytes: 15 * 1024 ** 3,
  usedBytes: 8 * 1024 ** 3,
  freeBytes: 7 * 1024 ** 3,
};

const drive: DriveStatusPort = { about: async () => QUOTA };

function pendingEvent(id: number): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(),
    endedAt: new Date(),
    videoPath: `/var/lib/motion/${id}.mp4`,
    snapshotPath: null,
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
  };
}

afterEach(() => {
  delete process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS;
});

describe('GdriveStatusUseCase', () => {
  it('composes quota, pending count and health into a status result', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([pendingEvent(1), pendingEvent(2)]);
    const health = new InMemoryGdriveSyncHealth();
    const at = new Date('2026-04-08T15:30:00Z');
    health.recordSuccess(at);

    const result = await new GdriveStatusUseCase(drive, repo, health).execute();

    expect(result.quota).toEqual(QUOTA);
    expect(result.pendingUploads).toBe(2);
    expect(result.failedUploads).toBe(0);
    expect(result.lastUploadAt).toEqual(at);
    expect(result.cleanupMinAgeDays).toBe(30);
  });

  it('reports consecutive failures and last error from the health record', async () => {
    const health = new InMemoryGdriveSyncHealth();
    health.recordFailure('auth token expired');
    health.recordFailure('auth token expired');

    const result = await new GdriveStatusUseCase(
      drive,
      new InMemoryMediaRepository(),
      health,
    ).execute();

    expect(result.failedUploads).toBe(2);
    expect(result.lastError).toBe('auth token expired');
  });

  it('honours GDRIVE_CLEANUP_MIN_AGE_DAYS', async () => {
    process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS = '7';
    const result = await new GdriveStatusUseCase(
      drive,
      new InMemoryMediaRepository(),
      new InMemoryGdriveSyncHealth(),
    ).execute();
    expect(result.cleanupMinAgeDays).toBe(7);
  });
});
