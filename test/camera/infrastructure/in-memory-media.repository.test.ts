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
