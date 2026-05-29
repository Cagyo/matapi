import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupLocalStorageUseCase } from '../../../src/camera/application/cleanup-local-storage.use-case';
import { CameraAdminAlert } from '../../../src/camera/domain/ports/admin-alert.port';
import { LocalStoragePort } from '../../../src/camera/domain/ports/local-storage.port';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { RetentionPrunePort } from '../../../src/camera/domain/ports/retention-prune.port';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
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

afterEach(() => {
  delete process.env.DISK_CRITICAL_PERCENT;
  delete process.env.DISK_EMERGENCY_PERCENT;
});

describe('CleanupLocalStorageUseCase', () => {
  it('does nothing below the critical threshold', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const storage = fakeStorage(50);

    await new CleanupLocalStorageUseCase(
      storage,
      repo,
      repo,
      fakeRetention(),
      fakeMotion(),
      fakeAlert(),
    ).execute();

    expect(storage.deleteFile).not.toHaveBeenCalled();
    expect((await repo.findUploadedNotDeleted()).length).toBe(1);
  });

  it('deletes only uploaded files and marks them local-deleted at critical', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1), notUploadedEvent(2)]);
    const storage = fakeStorage(85);
    const motion = fakeMotion();
    const alert = fakeAlert();

    await new CleanupLocalStorageUseCase(
      storage,
      repo,
      repo,
      fakeRetention(),
      motion,
      alert,
    ).execute();

    // event 1 (uploaded): video + snapshot deleted; event 2 untouched
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.jpg');
    expect(storage.deleteFile).not.toHaveBeenCalledWith('/var/lib/motion/2.mp4');
    expect(storage.pruneEmptyDirs).toHaveBeenCalledOnce();
    expect(motion.stop).not.toHaveBeenCalled();
    expect(alert.alert).not.toHaveBeenCalled();
  });

  it('prunes logs, stops motion and alerts at the emergency threshold', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const retention = fakeRetention();
    const motion = fakeMotion();
    const alert = fakeAlert();

    await new CleanupLocalStorageUseCase(
      fakeStorage(96),
      repo,
      repo,
      retention,
      motion,
      alert,
    ).execute();

    expect(retention.pruneEventsOlderThan).toHaveBeenCalledOnce();
    expect(retention.pruneSensorLogsOlderThan).toHaveBeenCalledOnce();
    expect(motion.stop).toHaveBeenCalledOnce();
    expect(alert.calls).toEqual(['emergency-disk-cleanup']);
  });
});
