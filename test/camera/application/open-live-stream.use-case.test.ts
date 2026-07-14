import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';
import { LiveStreamSourceResolverService } from '../../../src/camera/application/live-stream-source-resolver.service';
import { OpenLiveStreamUseCase } from '../../../src/camera/application/open-live-stream.use-case';
import { RtspSourceStartGate } from '../../../src/camera/application/rtsp-source-start-gate.service';
import { LiveStreamSourceUnavailableError } from '../../../src/camera/domain/errors/live-stream-source-unavailable.error';
import type { Camera } from '../../../src/camera/domain/camera.entity';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';
import type { LiveStreamGatewayPort } from '../../../src/camera/domain/ports/live-stream-gateway.port';
import type { LiveStreamLeasePort } from '../../../src/camera/domain/ports/live-stream-lease.port';
import type { MonotonicClockPort } from '../../../src/camera/domain/ports/monotonic-clock.port';

describe('OpenLiveStreamUseCase', () => {
  it('exposes the RTSP start gate as a Nest-resolvable constructor dependency', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'home-worker-di-'));

    try {
      execFileSync(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '--project',
          resolve('tsconfig.json'),
          '--outDir',
          outputDir,
          '--incremental',
          'false',
        ],
        { stdio: 'pipe' },
      );

      const compiledUseCase = readFileSync(
        join(outputDir, 'camera/application/open-live-stream.use-case.js'),
        'utf8',
      );

      expect(compiledUseCase).toContain(
        'rtsp_source_start_gate_service_1.RtspSourceStartGate])',
      );
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

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
    const source = await new LiveStreamSourceResolverService(
      new FakeMediaRepository([camera('Front door')]),
    ).resolve('Front door');

    expect(source.upstreamUrl).toBe('http://127.0.0.1:8081/?action=stream');
  });

  it('resolves a motion-alert camera strictly by repository id', async () => {
    const media = new FakeMediaRepository([
      { ...camera('Front door'), id: 'front_door_camera' },
    ]);

    const source = await new LiveStreamSourceResolverService(media).resolveById('front_door_camera');

    expect(source).toMatchObject({
      cameraId: 'front_door_camera',
      cameraName: 'Front door',
      upstreamUrl: 'http://127.0.0.1:8081/?action=stream',
    });
  });

  it('rejects a forged callback value that matches only a camera name', async () => {
    const media = new FakeMediaRepository([
      { ...camera('Front door'), id: 'front_door_camera' },
    ]);

    await expect(createUseCase(media).executeById({
      telegramId: 7,
      cameraId: 'Front door',
    })).rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('chooses the id target for callbacks and the name target for commands on collision', async () => {
    const media = new FakeMediaRepository([
      { ...camera('ID target'), id: 'collision' },
      { ...camera('collision'), id: 'named-target' },
    ]);
    const callbackUseCase = createUseCase(media);
    const commandUseCase = createUseCase(media);

    await expect(callbackUseCase.executeById({
      telegramId: 7,
      cameraId: 'collision',
    })).resolves.toMatchObject({ cameraName: 'ID target' });
    await expect(commandUseCase.execute({
      telegramId: 7,
      cameraName: 'collision',
    })).resolves.toMatchObject({ cameraName: 'collision' });
  });

  it('rejects disabled cameras as unavailable stream sources', async () => {
    const media = new FakeMediaRepository([{ ...camera('Front door'), enabled: false }]);

    await expect(createUseCase(media).execute({ telegramId: 7, cameraName: 'Front door' }))
      .rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('maps named-camera repository failures to an unavailable stream source', async () => {
    const media = new FakeMediaRepository([camera('Front door')]);
    media.findCameraError = new Error('database unavailable');

    await expect(new LiveStreamSourceResolverService(media).resolve('Front door'))
      .rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('maps default-camera repository failures to an unavailable stream source', async () => {
    const media = new FakeMediaRepository([camera('Front door')]);
    media.listCamerasError = new Error('database unavailable');

    await expect(new LiveStreamSourceResolverService(media).resolve())
      .rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('selects the first enabled Motion camera when another camera type is listed first', async () => {
    const media = new FakeMediaRepository([
      { ...camera('Doorbell'), id: 'doorbell', type: 'rtsp' },
      { ...camera('Front door'), id: 'front-door' },
    ]);

    await expect(new LiveStreamSourceResolverService(media).resolve()).resolves.toMatchObject({
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
    new LiveStreamSourceResolverService(media),
    session,
    { isAvailable: async () => true },
    new RtspSourceStartGate(),
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
