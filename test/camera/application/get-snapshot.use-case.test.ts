import { describe, expect, it } from 'vitest';
import { GetSnapshotUseCase } from '../../../src/camera/application/get-snapshot.use-case';
import { CameraNotFoundError } from '../../../src/camera/domain/errors/camera-not-found.error';
import { MotionNotRunningError } from '../../../src/camera/domain/errors/motion-not-running.error';
import { NoCamerasConfiguredError } from '../../../src/camera/domain/errors/no-cameras-configured.error';
import { Camera } from '../../../src/camera/domain/camera.entity';
import { MotionControlPort } from '../../../src/camera/domain/ports/motion-control.port';
import { SnapshotPort } from '../../../src/camera/domain/ports/snapshot.port';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';

function camera(name: string): Camera {
  return { id: name, name, type: 'camera', config: null, enabled: true };
}

function motion(active: boolean): MotionControlPort {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    isActive: async () => active,
  };
}

const snapshot: SnapshotPort = {
  grab: async () => Buffer.from('jpeg'),
};

function repoWith(cameras: Camera[]): InMemoryMediaRepository {
  const repo = new InMemoryMediaRepository();
  repo.seedCameras(cameras);
  return repo;
}

describe('GetSnapshotUseCase', () => {
  it('grabs a snapshot from the first camera when none is named', async () => {
    const useCase = new GetSnapshotUseCase(
      repoWith([camera('front_door')]),
      motion(true),
      snapshot,
    );
    const result = await useCase.execute();
    expect(result.cameraName).toBe('front_door');
    expect(result.buffer.toString()).toBe('jpeg');
  });

  it('throws NoCamerasConfiguredError when none are configured', async () => {
    const useCase = new GetSnapshotUseCase(repoWith([]), motion(true), snapshot);
    await expect(useCase.execute()).rejects.toBeInstanceOf(NoCamerasConfiguredError);
  });

  it('throws CameraNotFoundError for an unknown named camera', async () => {
    const useCase = new GetSnapshotUseCase(
      repoWith([camera('front_door')]),
      motion(true),
      snapshot,
    );
    await expect(useCase.execute('garage')).rejects.toBeInstanceOf(CameraNotFoundError);
  });

  it('throws MotionNotRunningError when the daemon is stopped', async () => {
    const useCase = new GetSnapshotUseCase(
      repoWith([camera('front_door')]),
      motion(false),
      snapshot,
    );
    await expect(useCase.execute()).rejects.toBeInstanceOf(MotionNotRunningError);
  });
});
