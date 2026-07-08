import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupLocalStorageUseCase } from '../../../src/camera/application/cleanup-local-storage.use-case';
import { CameraAdminAlert } from '../../../src/camera/domain/ports/admin-alert.port';
import { LocalStoragePort } from '../../../src/camera/domain/ports/local-storage.port';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { RetentionPrunePort } from '../../../src/camera/domain/ports/retention-prune.port';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { MOTION_DESIRED_STATE_KEY } from '../../../src/camera/domain/motion-desired-state';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

function uploadedEvent(id: number): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(),
    endedAt: new Date(),
    videoPath: `/var/lib/motion/${id}.mp4`,
    snapshotPath: `/var/lib/motion/${id}.jpg`,
    uploadedToGdrive: true,
    gdriveFileId: `home-security/motion/${id}.mp4`,
    localDeleted: false,
  };
}

function notUploadedEvent(id: number): MotionEvent {
  return { ...uploadedEvent(id), uploadedToGdrive: false, gdriveFileId: null };
}

function fakeStorage(usage: number) {
  return {
    usagePercent: vi.fn(async () => usage),
    deleteFile: vi.fn(async () => {}),
    pruneEmptyDirs: vi.fn(async () => {}),
  } satisfies LocalStoragePort & {
    deleteFile: ReturnType<typeof vi.fn>;
    pruneEmptyDirs: ReturnType<typeof vi.fn>;
  };
}

function fakeRetention(): RetentionPrunePort & {
  pruneEventsOlderThan: ReturnType<typeof vi.fn>;
  pruneSensorLogsOlderThan: ReturnType<typeof vi.fn>;
} {
  return {
    pruneEventsOlderThan: vi.fn(async () => 0),
    pruneSensorLogsOlderThan: vi.fn(async () => 0),
  };
}

function fakeMotion(): MotionControlPort & { stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    isActive: vi.fn(async () => true),
  };
}

function fakeAlert() {
  const calls: CameraAdminAlert[] = [];
  return { calls, alert: vi.fn(async (kind: CameraAdminAlert) => void calls.push(kind)) };
}

function fakeMeta(val: string | null = null): SystemMetaRepositoryPort {
  return {
    get: vi.fn(async () => val),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

afterEach(() => {
  delete process.env.DISK_CRITICAL_PERCENT;
  delete process.env.DISK_EMERGENCY_PERCENT;
});

describe('CleanupLocalStorageUseCase', () => {
  it('does nothing below the critical threshold', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const storage = fakeStorage(50);

    const res = await new CleanupLocalStorageUseCase(
      storage,
      repo,
      repo,
      fakeRetention(),
      fakeMotion(),
      fakeAlert(),
      fakeMeta(),
    ).execute();

    expect(res).toEqual({ thresholdUsed: 80 });
    expect(storage.deleteFile).not.toHaveBeenCalled();
    expect((await repo.findUploadedNotDeleted()).length).toBe(1);
  });

  it('deletes only uploaded files and marks them local-deleted at critical', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1), notUploadedEvent(2)]);
    const storage = fakeStorage(85);
    const motion = fakeMotion();
    const alert = fakeAlert();

    const res = await new CleanupLocalStorageUseCase(
      storage,
      repo,
      repo,
      fakeRetention(),
      motion,
      alert,
      fakeMeta(),
    ).execute();

    expect(res).toEqual({ thresholdUsed: 80 });
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.jpg');
    expect(storage.deleteFile).not.toHaveBeenCalledWith('/var/lib/motion/2.mp4');
    expect(storage.pruneEmptyDirs).toHaveBeenCalledOnce();
    expect(motion.stop).not.toHaveBeenCalled();
    expect(alert.alert).not.toHaveBeenCalled();
  });

  it('uses auto_clean_threshold from metadata repository', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const storage = fakeStorage(75);

    // With auto_clean_threshold = 70, 75% usage should trigger cleanup
    const res = await new CleanupLocalStorageUseCase(
      storage,
      repo,
      repo,
      fakeRetention(),
      fakeMotion(),
      fakeAlert(),
      fakeMeta('70'),
    ).execute();

    expect(res).toEqual({ thresholdUsed: 70 });
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
  });

  it('uses custom override threshold when provided', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const storage = fakeStorage(65);

    // Override threshold = 60, should trigger cleanup even if DB is 80
    const res = await new CleanupLocalStorageUseCase(
      storage,
      repo,
      repo,
      fakeRetention(),
      fakeMotion(),
      fakeAlert(),
      fakeMeta('80'),
    ).execute(60);

    expect(res).toEqual({ thresholdUsed: 60 });
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
  });

  it('prunes logs, stops motion and alerts at the emergency threshold', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const retention = fakeRetention();
    const motion = fakeMotion();
    const alert = fakeAlert();
    const meta = fakeMeta();

    await new CleanupLocalStorageUseCase(
      fakeStorage(96),
      repo,
      repo,
      retention,
      motion,
      alert,
      meta,
    ).execute();

    expect(retention.pruneEventsOlderThan).toHaveBeenCalledOnce();
    expect(retention.pruneSensorLogsOlderThan).toHaveBeenCalledOnce();
    expect(meta.set).toHaveBeenCalledWith(MOTION_DESIRED_STATE_KEY, 'off');
    expect(motion.stop).toHaveBeenCalledOnce();
    expect(alert.calls).toEqual(['emergency-disk-cleanup']);
  });
});
