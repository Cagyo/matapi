import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupLocalStorageUseCase } from '../../../src/camera/application/cleanup-local-storage.use-case';
import { MOTION_DESIRED_STATE_KEY } from '../../../src/camera/domain/motion-desired-state';
import { CameraAdminAlert } from '../../../src/camera/domain/ports/admin-alert.port';
import { GdriveSyncHealthPort } from '../../../src/camera/domain/ports/gdrive-sync-health.port';
import { LocalStoragePort } from '../../../src/camera/domain/ports/local-storage.port';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { RetentionPrunePort } from '../../../src/camera/domain/ports/retention-prune.port';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

function uploadedEvent(id: number): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(Date.now() - id * 1000), // larger ids are older
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

/**
 * `usages` are returned by successive usagePercent() calls; the last value
 * repeats once the sequence is exhausted.
 */
function fakeStorage(
  usages: number | number[],
  orphans: (string | { path: string; mtimeMs: number; ctimeMs: number })[] = [],
  deleteResults: Record<string, boolean> = {},
) {
  const seq = Array.isArray(usages) ? usages : [usages];
  let call = 0;
  const oldMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
  return {
    usagePercent: vi.fn(async () => seq[Math.min(call++, seq.length - 1)]),
    deleteFile: vi.fn(async (path: string) => deleteResults[path] ?? true),
    pruneEmptyDirs: vi.fn(async () => {}),
    listFilesOlderThan: vi.fn(async () =>
      orphans.map((orphan) =>
        typeof orphan === 'string'
          ? { path: orphan, mtimeMs: oldMs, ctimeMs: Date.now() - 2 * 60 * 60 * 1000 }
          : orphan,
      ),
    ),
  } satisfies LocalStoragePort & {
    usagePercent: ReturnType<typeof vi.fn>;
    deleteFile: ReturnType<typeof vi.fn>;
    pruneEmptyDirs: ReturnType<typeof vi.fn>;
    listFilesOlderThan: ReturnType<typeof vi.fn>;
  };
}

function fakeRetention() {
  return {
    pruneEventsOlderThan: vi.fn(async () => 0),
    pruneSensorLogsOlderThan: vi.fn(async () => 0),
  } satisfies RetentionPrunePort & {
    pruneEventsOlderThan: ReturnType<typeof vi.fn>;
    pruneSensorLogsOlderThan: ReturnType<typeof vi.fn>;
  };
}

function fakeMotion() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    isActive: vi.fn(async () => true),
  } satisfies MotionControlPort & { stop: ReturnType<typeof vi.fn> };
}

function fakeAlert() {
  const calls: CameraAdminAlert[] = [];
  return { calls, alert: vi.fn(async (kind: CameraAdminAlert) => void calls.push(kind)) };
}

function memMeta(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const meta: SystemMetaRepositoryPort = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  return { meta, store };
}

function fakeHealth(lastSuccessAt: Date | null = null): GdriveSyncHealthPort {
  return {
    snapshot: () => ({ consecutiveFailures: 0, lastError: null, lastSuccessAt }),
    recordSuccess: async () => undefined,
    recordFailure: async () => undefined,
  };
}

interface Overrides {
  storage?: ReturnType<typeof fakeStorage>;
  repo?: InMemoryMediaRepository;
  retention?: ReturnType<typeof fakeRetention>;
  motion?: ReturnType<typeof fakeMotion>;
  alert?: ReturnType<typeof fakeAlert>;
  meta?: SystemMetaRepositoryPort;
  health?: GdriveSyncHealthPort;
}

function build(overrides: Overrides = {}) {
  const storage = overrides.storage ?? fakeStorage(50);
  const repo = overrides.repo ?? new InMemoryMediaRepository();
  const retention = overrides.retention ?? fakeRetention();
  const motion = overrides.motion ?? fakeMotion();
  const alert = overrides.alert ?? fakeAlert();
  const meta = overrides.meta ?? memMeta().meta;
  const health = overrides.health ?? fakeHealth();
  const useCase = new CleanupLocalStorageUseCase(
    storage,
    repo,
    repo,
    retention,
    motion,
    alert,
    meta,
    health,
  );
  return { useCase, storage, repo, retention, motion, alert, meta };
}

afterEach(() => {
  delete process.env.DISK_CRITICAL_PERCENT;
  delete process.env.DISK_EMERGENCY_PERCENT;
  delete process.env.DISK_WARN_PERCENT;
});

describe('CleanupLocalStorageUseCase', () => {
  it('does nothing below the critical threshold', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const { useCase, storage } = build({ repo, storage: fakeStorage(50) });

    const res = await useCase.execute();

    expect(res).toEqual({ thresholdUsed: 80 });
    expect(storage.deleteFile).not.toHaveBeenCalled();
    expect((await repo.findUploadedNotDeleted()).length).toBe(1);
  });

  it('deletes only uploaded files and marks them local-deleted at critical', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1), notUploadedEvent(2)]);
    const { useCase, storage, motion, alert } = build({
      repo,
      storage: fakeStorage([85, 60]),
    });

    const res = await useCase.execute();

    expect(res).toEqual({ thresholdUsed: 80 });
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.jpg');
    expect(storage.deleteFile).not.toHaveBeenCalledWith('/var/lib/motion/2.mp4');
    expect(storage.pruneEmptyDirs).toHaveBeenCalled();
    expect(motion.stop).not.toHaveBeenCalled();
    expect(alert.alert).not.toHaveBeenCalled();
  });

  it('does not mark local-deleted when any referenced file deletion fails', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const storage = fakeStorage([85, 60], [], { '/var/lib/motion/1.jpg': false });
    const { useCase } = build({ repo, storage });

    await useCase.execute();

    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.jpg');
    expect((await repo.findUploadedNotDeleted()).map((e) => e.id)).toEqual([1]);
  });

  it('uses auto_clean_threshold from metadata repository', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const { useCase, storage } = build({
      repo,
      storage: fakeStorage([75, 60]),
      meta: memMeta({ auto_clean_threshold: '70' }).meta,
    });

    const res = await useCase.execute();

    expect(res).toEqual({ thresholdUsed: 70 });
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
  });

  it('uses custom override threshold when provided', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const { useCase, storage } = build({
      repo,
      storage: fakeStorage([65, 50]),
      meta: memMeta({ auto_clean_threshold: '80' }).meta,
    });

    const res = await useCase.execute(60);

    expect(res).toEqual({ thresholdUsed: 60 });
    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/1.mp4');
  });

  it('stops deleting once usage drops below the target', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents(Array.from({ length: 25 }, (_, i) => uploadedEvent(i + 1)));
    // 85 -> cleanup; first re-check (after one event group) reports 60 < target 75.
    const { useCase, repo: r } = build({ repo, storage: fakeStorage([85, 60]) });

    await useCase.execute();

    expect((await r.findUploadedNotDeleted()).map((event) => event.id)).toEqual([
      24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
      5, 4, 3, 2, 1,
    ]);
  });

  it('prunes logs, records desired=off, stops motion and alerts at emergency', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const { store, meta } = memMeta();
    const retention = fakeRetention();
    const motion = fakeMotion();
    const alert = fakeAlert();
    const { useCase } = build({
      repo,
      storage: fakeStorage([96, 96]),
      retention,
      motion,
      alert,
      meta,
    });

    await useCase.execute();

    expect(retention.pruneEventsOlderThan).toHaveBeenCalledOnce();
    expect(retention.pruneSensorLogsOlderThan).toHaveBeenCalledOnce();
    expect(store.get(MOTION_DESIRED_STATE_KEY)).toBe('off');
    expect(motion.stop).toHaveBeenCalledOnce();
    expect(alert.calls).toEqual(['emergency-disk-cleanup']);
  });

  it('skips emergency when the critical cleanup already freed enough space', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const retention = fakeRetention();
    const motion = fakeMotion();
    // Initial read 96 (emergency territory) but 80 after deletions.
    const { useCase } = build({ repo, storage: fakeStorage([96, 80]), retention, motion });

    await useCase.execute();

    expect(retention.pruneEventsOlderThan).not.toHaveBeenCalled();
    expect(motion.stop).not.toHaveBeenCalled();
  });

  it('sends the disk warning at most once per cooldown window', async () => {
    const { meta } = memMeta();
    const alert = fakeAlert();
    const first = build({ storage: fakeStorage(75), alert, meta });
    await first.useCase.execute();
    const second = build({ storage: fakeStorage(75), alert, meta });
    await second.useCase.execute();

    expect(alert.calls).toEqual(['disk-warning']);
  });

  it('does not persist the warning cooldown when alert delivery fails', async () => {
    const { store, meta } = memMeta();
    const alert = fakeAlert();
    alert.alert.mockRejectedValueOnce(new Error('notify failed'));
    const { useCase } = build({ storage: fakeStorage(75), alert, meta });

    await expect(useCase.execute()).resolves.toEqual({ thresholdUsed: 80 });

    expect(store.has('last_alert_disk_warning')).toBe(false);
  });

  it('sends the emergency alert at most once per cooldown window', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const { meta } = memMeta();
    const alert = fakeAlert();
    const first = build({ repo, storage: fakeStorage([96, 96]), alert, meta });
    await first.useCase.execute();
    const second = build({ repo, storage: fakeStorage([96, 96]), alert, meta });
    await second.useCase.execute();

    expect(alert.calls).toEqual(['emergency-disk-cleanup']);
  });

  it('does not persist the emergency cooldown when alert delivery fails', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const { store, meta } = memMeta();
    const retention = fakeRetention();
    const motion = fakeMotion();
    const alert = fakeAlert();
    alert.alert.mockRejectedValueOnce(new Error('notify failed'));
    const { useCase } = build({
      repo,
      storage: fakeStorage([96, 96]),
      retention,
      motion,
      alert,
      meta,
    });

    await expect(useCase.execute()).resolves.toEqual({ thresholdUsed: 80 });

    expect(retention.pruneEventsOlderThan).toHaveBeenCalledOnce();
    expect(retention.pruneSensorLogsOlderThan).toHaveBeenCalledOnce();
    expect(motion.stop).toHaveBeenCalledOnce();
    expect(store.get(MOTION_DESIRED_STATE_KEY)).toBe('off');
    expect(store.has('last_alert_emergency_cleanup')).toBe(false);
  });

  it('still stops motion and alerts when desired-state persistence fails', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const retention = fakeRetention();
    const motion = fakeMotion();
    const alert = fakeAlert();
    const meta: SystemMetaRepositoryPort = {
      get: async () => null,
      set: async (key) => {
        if (key === MOTION_DESIRED_STATE_KEY) {
          throw new Error('system_meta unavailable');
        }
      },
      delete: async () => undefined,
    };
    const { useCase } = build({
      repo,
      storage: fakeStorage([96, 96]),
      retention,
      motion,
      alert,
      meta,
    });

    await expect(useCase.execute()).resolves.toEqual({ thresholdUsed: 80 });

    expect(retention.pruneEventsOlderThan).toHaveBeenCalledOnce();
    expect(retention.pruneSensorLogsOlderThan).toHaveBeenCalledOnce();
    expect(motion.stop).toHaveBeenCalledOnce();
    expect(alert.calls).toEqual(['emergency-disk-cleanup']);
  });

  it('continues into emergency handling when orphan reference loading fails', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    vi.spyOn(repo, 'listAllMediaPaths').mockRejectedValueOnce(new Error('db unavailable'));
    const { store, meta } = memMeta();
    const retention = fakeRetention();
    const motion = fakeMotion();
    const alert = fakeAlert();
    const storage = fakeStorage([96, 96, 96], ['/var/lib/motion/2026/01/01/999.mp4']);
    const { useCase } = build({
      repo,
      storage,
      retention,
      motion,
      alert,
      meta,
      health: fakeHealth(new Date()),
    });

    await expect(useCase.execute()).resolves.toEqual({ thresholdUsed: 80 });

    expect(storage.listFilesOlderThan).not.toHaveBeenCalled();
    expect(storage.usagePercent).toHaveBeenCalledTimes(3);
    expect(retention.pruneEventsOlderThan).toHaveBeenCalledOnce();
    expect(retention.pruneSensorLogsOlderThan).toHaveBeenCalledOnce();
    expect(store.get(MOTION_DESIRED_STATE_KEY)).toBe('off');
    expect(motion.stop).toHaveBeenCalledOnce();
    expect(alert.calls).toEqual(['emergency-disk-cleanup']);
  });

  it('sweeps old unreferenced files when Drive sync succeeded recently', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1), notUploadedEvent(2)]);
    const storage = fakeStorage(
      [85, 60],
      ['/var/lib/motion/2026/01/01/999.mp4', '/var/lib/motion/2.mp4'],
    );
    const { useCase } = build({ repo, storage, health: fakeHealth(new Date()) });

    await useCase.execute();

    expect(storage.deleteFile).toHaveBeenCalledWith('/var/lib/motion/2026/01/01/999.mp4');
    // 2.mp4 belongs to a (not yet uploaded) event — referenced, never swept.
    expect(storage.deleteFile).not.toHaveBeenCalledWith('/var/lib/motion/2.mp4');
  });

  it('does not sweep an old-mtime orphan created after the last Drive sync', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const lastSuccessAt = new Date(Date.now() - 60_000);
    const storage = fakeStorage([85, 60], [
      {
        path: '/var/lib/motion/2026/01/01/restored.mp4',
        mtimeMs: Date.now() - 10 * 24 * 60 * 60 * 1000,
        ctimeMs: Date.now(),
      },
    ]);
    const { useCase } = build({ repo, storage, health: fakeHealth(lastSuccessAt) });

    await useCase.execute();

    expect(storage.deleteFile).not.toHaveBeenCalledWith(
      '/var/lib/motion/2026/01/01/restored.mp4',
    );
  });

  it('skips the orphan sweep without a recent Drive sync success', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([uploadedEvent(1)]);
    const storage = fakeStorage([85, 60], ['/var/lib/motion/2026/01/01/999.mp4']);
    const { useCase } = build({ repo, storage, health: fakeHealth(null) });

    await useCase.execute();

    expect(storage.listFilesOlderThan).not.toHaveBeenCalled();
    expect(storage.deleteFile).not.toHaveBeenCalledWith('/var/lib/motion/2026/01/01/999.mp4');
  });
});
