import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadMotionUseCase } from '../../../src/camera/application/upload-motion.use-case';
import { CameraAdminAlert } from '../../../src/camera/domain/ports/admin-alert.port';
import { DriveSyncPort } from '../../../src/camera/domain/ports/drive-sync.port';
import { MediaFilePort } from '../../../src/camera/domain/ports/media-file.port';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { InMemoryGdriveSyncHealth } from '../../../src/camera/infrastructure/in-memory-gdrive-sync-health';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

const TWO_MIN_AGO = new Date(Date.now() - 2 * 60_000);
const OLD_MTIME = Date.now() - 10 * 60_000;

function event(id: number, endedAt: Date | null): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(Date.now() - 3 * 60_000),
    endedAt,
    videoPath: `/var/lib/motion/2026/04/08/${id}.mp4`,
    snapshotPath: null,
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
  };
}

function fakeAlert() {
  const calls: { kind: CameraAdminAlert; detail?: string }[] = [];
  return {
    calls,
    alert: vi.fn(async (kind: CameraAdminAlert, detail?: string) => {
      calls.push({ kind, detail });
    }),
  };
}

function okDrive(): DriveSyncPort {
  return {
    copyMotionFiles: vi.fn(async () => {}),
    pruneMotionFiles: vi.fn(async () => {}),
    uploadBackup: vi.fn(async () => {}),
    pruneBackups: vi.fn(async () => {}),
  };
}

/** By default every file exists with a comfortably old mtime. */
function fakeFiles(mtimes: Record<string, number | null> = {}): MediaFilePort {
  return {
    exists: vi.fn(async () => true),
    sizeBytes: vi.fn(async () => 1024),
    localUsageBytes: vi.fn(async () => null),
    mtimeMs: vi.fn(async (path: string) =>
      path in mtimes ? mtimes[path] : OLD_MTIME,
    ),
  };
}

afterEach(() => {
  delete process.env.MOTION_LOCAL_DIR;
  delete process.env.GDRIVE_REMOTE_PATH;
});

describe('UploadMotionUseCase', () => {
  it('marks eligible events uploaded with their remote path and records success', async () => {
    process.env.MOTION_LOCAL_DIR = '/var/lib/motion';
    process.env.GDRIVE_REMOTE_PATH = 'home-security/motion';
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([event(1, TWO_MIN_AGO)]);
    const health = new InMemoryGdriveSyncHealth();
    const drive = okDrive();

    await new UploadMotionUseCase(
      repo,
      repo,
      drive,
      health,
      fakeAlert(),
      fakeFiles(),
    ).execute();

    expect(drive.copyMotionFiles).toHaveBeenCalledOnce();
    const [pending] = await repo.findPendingUploads();
    expect(pending).toBeUndefined();
    const [uploaded] = await repo.findUploadedNotDeleted();
    expect(uploaded.gdriveFileId).toBe('home-security/motion/2026/04/08/1.mp4');
    expect(health.snapshot().consecutiveFailures).toBe(0);
  });

  it('skips events younger than the min-age and does not copy', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([event(1, new Date())]);
    const drive = okDrive();

    await new UploadMotionUseCase(
      repo,
      repo,
      drive,
      new InMemoryGdriveSyncHealth(),
      fakeAlert(),
      fakeFiles(),
    ).execute();

    expect(drive.copyMotionFiles).not.toHaveBeenCalled();
    expect((await repo.findUploadedNotDeleted()).length).toBe(0);
  });

  it('does not mark an event whose file mtime is too fresh for --min-age', async () => {
    const repo = new InMemoryMediaRepository();
    const fresh = event(1, TWO_MIN_AGO);
    const old = event(2, TWO_MIN_AGO);
    repo.seedEvents([fresh, old]);
    const drive = okDrive();

    await new UploadMotionUseCase(
      repo,
      repo,
      drive,
      new InMemoryGdriveSyncHealth(),
      fakeAlert(),
      fakeFiles({ [fresh.videoPath!]: Date.now() - 10_000 }),
    ).execute();

    expect(drive.copyMotionFiles).toHaveBeenCalledOnce();
    const uploadedIds = (await repo.findUploadedNotDeleted()).map((e) => e.id);
    expect(uploadedIds).toEqual([2]);
  });

  it('does not mark an event whose snapshot is too fresh for --min-age', async () => {
    const repo = new InMemoryMediaRepository();
    const withSnap = {
      ...event(1, TWO_MIN_AGO),
      snapshotPath: '/var/lib/motion/2026/04/08/1.jpg',
    };
    repo.seedEvents([withSnap, event(2, TWO_MIN_AGO)]);
    const drive = okDrive();

    await new UploadMotionUseCase(
      repo,
      repo,
      drive,
      new InMemoryGdriveSyncHealth(),
      fakeAlert(),
      fakeFiles({ '/var/lib/motion/2026/04/08/1.jpg': Date.now() - 10_000 }),
    ).execute();

    expect(drive.copyMotionFiles).toHaveBeenCalledOnce();
    expect((await repo.findUploadedNotDeleted()).map((e) => e.id)).toEqual([2]);
  });

  it('does not mark an event whose local file is missing', async () => {
    const repo = new InMemoryMediaRepository();
    const gone = event(1, TWO_MIN_AGO);
    repo.seedEvents([gone]);
    const drive = okDrive();

    await new UploadMotionUseCase(
      repo,
      repo,
      drive,
      new InMemoryGdriveSyncHealth(),
      fakeAlert(),
      fakeFiles({ [gone.videoPath!]: null }),
    ).execute();

    expect(drive.copyMotionFiles).not.toHaveBeenCalled();
    expect((await repo.findUploadedNotDeleted()).length).toBe(0);
  });

  it('records failure and leaves events un-uploaded when rclone fails', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([event(1, TWO_MIN_AGO)]);
    const health = new InMemoryGdriveSyncHealth();
    const drive = okDrive();
    drive.copyMotionFiles = vi.fn(async () => {
      throw new Error('auth token expired');
    });
    const alert = fakeAlert();

    await new UploadMotionUseCase(
      repo,
      repo,
      drive,
      health,
      alert,
      fakeFiles(),
    ).execute();

    expect(health.snapshot().consecutiveFailures).toBe(1);
    expect((await repo.findUploadedNotDeleted()).length).toBe(0);
    expect(alert.alert).not.toHaveBeenCalled();
  });

  it('alerts admins on the fifth consecutive failure only', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([event(1, TWO_MIN_AGO)]);
    const health = new InMemoryGdriveSyncHealth();
    const drive = okDrive();
    drive.copyMotionFiles = vi.fn(async () => {
      throw new Error('boom');
    });
    const alert = fakeAlert();
    const useCase = new UploadMotionUseCase(
      repo,
      repo,
      drive,
      health,
      alert,
      fakeFiles(),
    );

    for (let i = 0; i < 6; i++) await useCase.execute();

    expect(alert.alert).toHaveBeenCalledOnce();
    expect(alert.calls[0]).toEqual({ kind: 'gdrive-sync-failing', detail: 'boom' });
  });
});
