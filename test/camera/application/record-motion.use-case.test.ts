import { describe, expect, it } from 'vitest';
import { RecordMotionEndUseCase } from '../../../src/camera/application/record-motion-end.use-case';
import { RecordMotionStartUseCase } from '../../../src/camera/application/record-motion-start.use-case';
import { RecordSnapshotUseCase } from '../../../src/camera/application/record-snapshot.use-case';
import { Camera } from '../../../src/camera/domain/camera.entity';
import { MotionAlertPort } from '../../../src/camera/domain/ports/motion-alert.port';
import { SnapshotPort } from '../../../src/camera/domain/ports/snapshot.port';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

function camera(name: string): Camera {
  return { id: name, name, type: 'camera', config: null, enabled: true };
}

class RecordingAlert implements MotionAlertPort {
  readonly calls: { cameraName: string; at: Date; photo: Buffer | null }[] = [];
  async motionStarted(cameraName: string, at: Date, photo: Buffer | null): Promise<void> {
    this.calls.push({ cameraName, at, photo });
  }
}

const okSnapshot: SnapshotPort = { grab: async () => Buffer.from('jpeg') };
const failingSnapshot: SnapshotPort = {
  grab: async () => {
    throw new Error('no camera');
  },
};

function repoWith(cameras: Camera[]): InMemoryMediaRepository {
  const repo = new InMemoryMediaRepository();
  repo.seedCameras(cameras);
  return repo;
}

describe('RecordMotionStartUseCase', () => {
  it('opens an event and raises an alert with a snapshot', async () => {
    const repo = repoWith([camera('front_door')]);
    const alert = new RecordingAlert();
    const useCase = new RecordMotionStartUseCase(repo, repo, okSnapshot, alert);

    await useCase.execute('front_door');

    const last = await repo.lastEvent();
    expect(last?.cameraId).toBe('front_door');
    expect(last?.endedAt).toBeNull();
    expect(alert.calls).toHaveLength(1);
    expect(alert.calls[0].photo?.toString()).toBe('jpeg');
  });

  it('still records the event and alerts with null photo when snapshot fails', async () => {
    const repo = repoWith([camera('front_door')]);
    const alert = new RecordingAlert();
    const useCase = new RecordMotionStartUseCase(repo, repo, failingSnapshot, alert);

    await useCase.execute();

    expect(await repo.lastEvent()).not.toBeNull();
    expect(alert.calls[0].photo).toBeNull();
  });

  it('does nothing when no cameras are configured', async () => {
    const repo = repoWith([]);
    const alert = new RecordingAlert();
    const useCase = new RecordMotionStartUseCase(repo, repo, okSnapshot, alert);

    await useCase.execute('ghost');

    expect(await repo.lastEvent()).toBeNull();
    expect(alert.calls).toHaveLength(0);
  });
});

describe('RecordMotionEndUseCase', () => {
  it('closes the latest open event with the video path', async () => {
    const repo = repoWith([camera('front_door')]);
    await repo.createEvent('front_door', new Date('2026-07-01T10:00:00Z'));
    const useCase = new RecordMotionEndUseCase(repo, repo);

    await useCase.execute('front_door', '/var/lib/motion/clip.mkv');

    const last = await repo.lastEvent();
    expect(last?.endedAt).not.toBeNull();
    expect(last?.videoPath).toBe('/var/lib/motion/clip.mkv');
    expect(last?.uploadedToGdrive).toBe(false);
  });

  it('is a no-op when there is no open event', async () => {
    const repo = repoWith([camera('front_door')]);
    const useCase = new RecordMotionEndUseCase(repo, repo);

    await expect(
      useCase.execute('front_door', '/var/lib/motion/clip.mkv'),
    ).resolves.toBeUndefined();
  });
});

describe('RecordSnapshotUseCase', () => {
  it('attaches the snapshot path to the latest open event', async () => {
    const repo = repoWith([camera('front_door')]);
    await repo.createEvent('front_door', new Date('2026-07-01T10:00:00Z'));
    const useCase = new RecordSnapshotUseCase(repo);

    await useCase.execute('/var/lib/motion/snap.jpg');

    const last = await repo.lastEvent();
    expect(last?.snapshotPath).toBe('/var/lib/motion/snap.jpg');
  });
});
