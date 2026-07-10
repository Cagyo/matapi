import { describe, expect, it } from 'vitest';
import { RecordMotionEndUseCase } from '../../../src/camera/application/record-motion-end.use-case';
import { RecordMotionStartUseCase } from '../../../src/camera/application/record-motion-start.use-case';
import { RecordSnapshotUseCase } from '../../../src/camera/application/record-snapshot.use-case';
import { Camera } from '../../../src/camera/domain/camera.entity';
import { MotionAlertPort } from '../../../src/camera/domain/ports/motion-alert.port';
import { SnapshotPort } from '../../../src/camera/domain/ports/snapshot.port';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';
import { MotionHooksController } from '../../../src/camera/interfaces/motion-hooks.controller';

function camera(name: string): Camera {
  return { id: name, name, type: 'camera', config: null, enabled: true };
}

const snapshot: SnapshotPort = { grab: async () => Buffer.from('jpeg') };
const silentAlert: MotionAlertPort = { motionStarted: async () => undefined };

function build() {
  const repo = new InMemoryMediaRepository();
  repo.seedCameras([camera('front_door')]);
  const controller = new MotionHooksController(
    new RecordMotionStartUseCase(repo, repo, snapshot, silentAlert),
    new RecordMotionEndUseCase(repo, repo),
    new RecordSnapshotUseCase(repo),
  );
  return { repo, controller };
}

describe('MotionHooksController', () => {
  it('records start → snapshot → end across the hook lifecycle', async () => {
    const { repo, controller } = build();

    expect(await controller.eventStart('front_door')).toEqual({ ok: true });
    expect(await controller.snapshot('/snap.jpg')).toEqual({ ok: true });
    expect(await controller.eventEnd('front_door', '/clip.mkv')).toEqual({ ok: true });

    const last = await repo.lastEvent();
    expect(last?.snapshotPath).toBe('/snap.jpg');
    expect(last?.videoPath).toBe('/clip.mkv');
    expect(last?.endedAt).not.toBeNull();
  });

  it('acks and skips when the end hook omits the file param', async () => {
    const { repo, controller } = build();
    await controller.eventStart('front_door');

    expect(await controller.eventEnd('front_door', undefined)).toEqual({ ok: true });

    const last = await repo.lastEvent();
    expect(last?.videoPath).toBeNull();
    expect(last?.endedAt).toBeNull();
  });

  it('records every movie-end hook as a separate video event', async () => {
    const { repo, controller } = build();

    expect(await controller.movieEnd('front_door', '/clip-1.avi')).toEqual({ ok: true });
    expect(await controller.movieEnd('front_door', '/clip-2.avi')).toEqual({ ok: true });

    const events = await repo.listLatestEvents(10);
    expect(events.map((event) => event.videoPath).sort()).toEqual([
      '/clip-1.avi',
      '/clip-2.avi',
    ]);
    expect(events.every((event) => event.endedAt !== null)).toBe(true);
  });

  it('never throws — returns ok even with no cameras configured', async () => {
    const repo = new InMemoryMediaRepository();
    const controller = new MotionHooksController(
      new RecordMotionStartUseCase(repo, repo, snapshot, silentAlert),
      new RecordMotionEndUseCase(repo, repo),
      new RecordSnapshotUseCase(repo),
    );

    expect(await controller.eventStart('ghost')).toEqual({ ok: true });
  });
});
