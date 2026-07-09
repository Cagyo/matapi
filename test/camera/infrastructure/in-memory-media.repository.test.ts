import { describe, expect, it } from 'vitest';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

function event(
  id: number,
  videoPath: string | null,
  snapshotPath: string | null,
  uploadedToGdrive: boolean,
  localDeleted: boolean,
): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(),
    endedAt: new Date(),
    videoPath,
    snapshotPath,
    uploadedToGdrive,
    gdriveFileId: null,
    localDeleted,
  };
}

describe('InMemoryMediaRepository.listAllMediaPaths', () => {
  it('returns every non-null video and snapshot path, regardless of flags', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([
      event(1, '/m/1.mp4', '/m/1.jpg', false, false),
      event(2, '/m/2.mp4', null, true, false),
      event(3, null, '/m/3.jpg', false, true),
      event(4, null, null, true, true),
    ]);

    const paths = await repo.listAllMediaPaths();

    expect(paths.sort()).toEqual(['/m/1.jpg', '/m/1.mp4', '/m/2.mp4', '/m/3.jpg']);
  });
});

describe('InMemoryMediaRepository browse queries', () => {
  function browseEvent(id: number, startedAt: string): MotionEvent {
    return {
      id,
      cameraId: 'front_door',
      startedAt: new Date(startedAt),
      endedAt: new Date(new Date(startedAt).getTime() + 30_000),
      videoPath: `/m/${id}.mp4`,
      snapshotPath: null,
      uploadedToGdrive: false,
      gdriveFileId: null,
      localDeleted: false,
    };
  }

  it('lists latest events newest first with the requested raw limit', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([
      browseEvent(1, '2026-04-08T12:00:00'),
      browseEvent(2, '2026-04-08T12:05:00'),
      browseEvent(3, '2026-04-08T12:10:00'),
    ]);

    const rows = await repo.listLatestEvents(2);

    expect(rows.map((e) => e.id)).toEqual([3, 2]);
  });

  it('lists events started inside the requested range newest first', async () => {
    const repo = new InMemoryMediaRepository();
    repo.seedEvents([
      browseEvent(1, '2026-04-08T17:59:59'),
      browseEvent(2, '2026-04-08T18:00:00'),
      browseEvent(3, '2026-04-08T22:59:59'),
      browseEvent(4, '2026-04-08T23:00:00'),
    ]);

    const rows = await repo.listEventsStartedBetween(
      new Date('2026-04-08T18:00:00'),
      new Date('2026-04-08T23:00:00'),
      10,
    );

    expect(rows.map((e) => e.id)).toEqual([3, 2]);
  });
});
