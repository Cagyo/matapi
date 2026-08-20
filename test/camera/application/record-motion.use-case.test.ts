import { describe, expect, it, vi } from 'vitest';
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
    throw new Error('EIO: /private/motion/snapshot.jpg');
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
    const logger = (useCase as unknown as { logger: { warn(message: string): void } }).logger;
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await useCase.execute();

    expect(await repo.lastEvent()).not.toBeNull();
    expect(alert.calls[0].photo).toBeNull();
    expect(log).toHaveBeenCalledWith('Motion alert snapshot failed: CAMERA_OPERATION_FAILED');
    expect(log.mock.calls.flat().join(' ')).not.toContain('/private/motion');
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

  it('creates a closed event when a movie file ends without an open event', async () => {
    const repo = repoWith([camera('front_door')]);
    const useCase = new RecordMotionEndUseCase(repo, repo);
    const logger = (useCase as unknown as { logger: { log(message: string): void } }).logger;
    const log = vi.spyOn(logger, 'log').mockImplementation(() => undefined);

    await useCase.execute('front_door', '/var/lib/motion/clip.mkv');

    const last = await repo.lastEvent();
    expect(last?.cameraId).toBe('front_door');
    expect(last?.videoPath).toBe('/var/lib/motion/clip.mkv');
    expect(last?.startedAt).not.toBeNull();
    expect(last?.endedAt).not.toBeNull();
    expect(log).toHaveBeenCalledWith('Motion end created a standalone video event');
    expect(log.mock.calls.flat().join(' ')).not.toContain('/var/lib/motion');
  });

  it('uses the Motion filename timestamp for standalone movie events', async () => {
    const repo = repoWith([camera('front_door')]);
    const useCase = new RecordMotionEndUseCase(repo, repo);

    await useCase.execute(
      'front_door',
      '/home/pi/motion/videos/2026/07/09/184949-0000020260709184917.avi',
    );

    const last = await repo.lastEvent();
    expect(last?.startedAt).toEqual(new Date(Date.UTC(2026, 6, 9, 18, 49, 49)));
  });

  it('wakes traversal even when immediate stability defers registration', async () => {
    const repo = repoWith([camera('front_door')]);
    await repo.createEvent('front_door', new Date('2026-07-01T10:00:00Z'));
    const registration = { executeForEvent: vi.fn(async () => undefined) };
    const recovery = { wake: vi.fn() };
    const useCase = new RecordMotionEndUseCase(repo, repo, undefined, registration, recovery);

    await useCase.execute('front_door', '/var/lib/motion/clip.mkv');

    expect(registration.executeForEvent).toHaveBeenCalledOnce();
    expect(recovery.wake).toHaveBeenCalledOnce();
    expect(recovery.wake).toHaveBeenCalledWith('motion-event');
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

  it('does not log a snapshot path when there is no open event', async () => {
    const repo = repoWith([camera('front_door')]);
    const useCase = new RecordSnapshotUseCase(repo);
    const logger = (useCase as unknown as { logger: { warn(message: string): void } }).logger;
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await useCase.execute('/private/motion/secret-snapshot.jpg');

    expect(log).toHaveBeenCalledWith('Snapshot saved without an open event');
    expect(log.mock.calls.flat().join(' ')).not.toContain('/private/motion');
  });
});
