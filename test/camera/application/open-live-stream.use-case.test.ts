import { describe, expect, it } from 'vitest';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';
import { MotionLiveSourceService } from '../../../src/camera/application/motion-live-source.service';
import { OpenLiveStreamUseCase } from '../../../src/camera/application/open-live-stream.use-case';
import { LiveStreamSourceUnavailableError } from '../../../src/camera/domain/errors/live-stream-source-unavailable.error';
import type { Camera } from '../../../src/camera/domain/camera.entity';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';
import type { LiveStreamGatewayPort } from '../../../src/camera/domain/ports/live-stream-gateway.port';
import type { LiveStreamLeasePort } from '../../../src/camera/domain/ports/live-stream-lease.port';
import type { MonotonicClockPort } from '../../../src/camera/domain/ports/monotonic-clock.port';

describe('OpenLiveStreamUseCase', () => {
  it('returns a tokenized tunnel URL for an enabled camera without trusting a camera URL', async () => {
    const media = new FakeMediaRepository([camera('Front door')]);
    const result = await createUseCase(media).execute({
      telegramId: 7,
      cameraName: 'front door',
    });

    expect(result.watchUrl).toMatch(
      /^https:\/\/clear-moon\.trycloudflare\.com\/watch\/[A-Za-z0-9_-]+$/,
    );
    expect(result.remainingMs).toBe(300_000);
    expect(media.requestedNames).toEqual(['front door']);
  });

  it('derives the installer-owned localhost Motion route', async () => {
    const source = await new MotionLiveSourceService(
      new FakeMediaRepository([camera('Front door')]),
    ).resolve('Front door');

    expect(source.upstreamUrl).toBe('http://127.0.0.1:8081/?action=stream');
  });

  it('rejects disabled cameras as unavailable stream sources', async () => {
    const media = new FakeMediaRepository([{ ...camera('Front door'), enabled: false }]);

    await expect(createUseCase(media).execute({ telegramId: 7, cameraName: 'Front door' }))
      .rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('maps named-camera repository failures to an unavailable stream source', async () => {
    const media = new FakeMediaRepository([camera('Front door')]);
    media.findCameraError = new Error('database unavailable');

    await expect(new MotionLiveSourceService(media).resolve('Front door'))
      .rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('maps default-camera repository failures to an unavailable stream source', async () => {
    const media = new FakeMediaRepository([camera('Front door')]);
    media.listCamerasError = new Error('database unavailable');

    await expect(new MotionLiveSourceService(media).resolve())
      .rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('selects the first enabled Motion camera when another camera type is listed first', async () => {
    const media = new FakeMediaRepository([
      { ...camera('Doorbell'), id: 'doorbell', type: 'rtsp' },
      { ...camera('Front door'), id: 'front-door' },
    ]);

    await expect(new MotionLiveSourceService(media).resolve()).resolves.toMatchObject({
      cameraId: 'front-door',
      cameraName: 'Front door',
    });
  });
});

function createUseCase(media: FakeMediaRepository): OpenLiveStreamUseCase {
  const gateway: LiveStreamGatewayPort = {
    start: async () => ({
      publicHostname: 'clear-moon.trycloudflare.com',
      pid: 123 as never,
      processIdentity: 'owned-process',
    }),
    addViewer: async () => undefined,
    revokeViewer: async () => undefined,
    stop: async () => undefined,
    recoverOwnedProcess: async () => 'stopped',
  };
  const lease: LiveStreamLeasePort = {
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
  };
  const clock: MonotonicClockPort = { now: () => 1_000 };
  const session = new LiveStreamSessionService(
    gateway,
    lease,
    clock,
    { alert: async () => undefined },
    { delete: async () => undefined },
    300_000,
  );
  return new OpenLiveStreamUseCase(
    new MotionLiveSourceService(media),
    session,
    { isAvailable: async () => true },
  );
}

function camera(name: string): Camera {
  return { id: 'front-door', name, type: 'motion', config: null, enabled: true };
}

class FakeMediaRepository implements MediaRepositoryPort {
  requestedNames: string[] = [];
  findCameraError?: Error;
  listCamerasError?: Error;

  constructor(private readonly cameras: Camera[]) {}

  async findCameraByName(name: string): Promise<Camera | null> {
    if (this.findCameraError) throw this.findCameraError;
    this.requestedNames.push(name);
    return this.cameras.find((camera) => camera.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  async listCameras(): Promise<Camera[]> {
    if (this.listCamerasError) throw this.listCamerasError;
    return this.cameras.filter((camera) => camera.enabled);
  }
  async findEventById() { return null; }
  async listEventsOnDay() { return []; }
  async listLatestEvents() { return []; }
  async listEventsStartedBetween() { return []; }
  async countEventsOnDay() { return 0; }
  async lastEvent() { return null; }
  async uploadStats() { return { pending: 0, lastUploadAt: null }; }
  async findPendingUploads() { return []; }
  async findUploadedNotDeleted() { return []; }
  async listAllMediaPaths() { return []; }
}
