import { describe, expect, it } from 'vitest';
import { CameraStatusUseCase } from '../../../src/camera/application/camera-status.use-case';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { MediaFilePort } from '../../../src/camera/domain/ports/media-file.port';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

const motion = (active: boolean): MotionControlPort => ({
  start: async () => undefined,
  stop: async () => undefined,
  restart: async () => undefined,
  isActive: async () => active,
});

const files = (bytes: number | null): MediaFilePort => ({
  exists: async () => true,
  sizeBytes: async () => bytes,
  mtimeMs: async () => (bytes === null ? null : Date.now() - 10 * 60_000),
  localUsageBytes: async () => bytes,
});

function todayEvent(id: number): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(),
    endedAt: new Date(),
    videoPath: null,
    snapshotPath: null,
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
  };
}

describe('CameraStatusUseCase', () => {
  it('aggregates daemon state, last event, storage and today count', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([todayEvent(1), todayEvent(2)]);

    const result = await new CameraStatusUseCase(
      motion(true),
      repo,
      files(847 * 1024 ** 2),
    ).execute();

    expect(result.running).toBe(true);
    expect(result.eventsToday).toBe(2);
    expect(result.localStorageBytes).toBe(847 * 1024 ** 2);
    expect(result.lastEventAt).toBeInstanceOf(Date);
  });

  it('reports null storage and stopped daemon gracefully', async () => {
    const result = await new CameraStatusUseCase(
      motion(false),
      new InMemoryMediaRepository(),
      files(null),
    ).execute();

    expect(result.running).toBe(false);
    expect(result.eventsToday).toBe(0);
    expect(result.localStorageBytes).toBeNull();
    expect(result.lastEventAt).toBeNull();
  });
});
