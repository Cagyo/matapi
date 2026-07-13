import { describe, expect, it, vi } from 'vitest';
import { LiveStreamSourceResolverService } from '../../../src/camera/application/live-stream-source-resolver.service';
import { ConfigureLiveSourceUseCase } from '../../../src/camera/application/configure-live-source.use-case';
import { LiveStreamSourceUnavailableError } from '../../../src/camera/domain/errors/live-stream-source-unavailable.error';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';
import type { LiveSourceProbePort } from '../../../src/camera/domain/ports/live-source-probe.port';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';

function media(cameras: { id: string; name: string; type: string; enabled: boolean }[]): MediaRepositoryPort {
  return {
    listCameras: vi.fn(async () => cameras.map((camera) => ({ ...camera, config: null }))),
    findCameraByName: vi.fn(async (name: string) => {
      const camera = cameras.find((candidate) => candidate.name === name);
      return camera ? { ...camera, config: null } : null;
    }),
  } as unknown as MediaRepositoryPort;
}

describe('live stream source resolver RTSP metadata boundary', () => {
  it('preserves Motion output and resolves ready RTSP by name/id without loading credentials', async () => {
    const cameras = [
      { id: 'motion-1', name: 'Motion', type: 'motion', enabled: true },
      { id: 'rtsp-1', name: 'Door RTSP', type: 'rtsp', enabled: true },
    ];
    const sources = {
      isReady: vi.fn(async (id: string) => id === 'rtsp-1'),
      loadForStream: vi.fn(() => { throw new Error('must not decrypt'); }),
    } as unknown as LiveSourceRepositoryPort;
    const resolver = new LiveStreamSourceResolverService(media(cameras), sources);

    await expect(resolver.resolve('Motion')).resolves.toEqual({
      kind: 'motion-mjpeg', cameraId: 'motion-1', cameraName: 'Motion',
      upstreamUrl: 'http://127.0.0.1:8081/?action=stream',
    });
    const byName = await resolver.resolve('Door RTSP');
    const byId = await resolver.resolveById('rtsp-1');

    expect(byName).toEqual({ kind: 'rtsp', cameraId: 'rtsp-1', cameraName: 'Door RTSP' });
    expect(byId).toEqual(byName);
    expect(Object.keys(byName).sort()).toEqual(['cameraId', 'cameraName', 'kind']);
    expect(sources.loadForStream).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'disabled', name: 'Disabled', type: 'rtsp', enabled: false, ready: true },
    { id: 'pending', name: 'Pending', type: 'rtsp', enabled: true, ready: false },
  ])('rejects unavailable RTSP metadata for $id', async (camera) => {
    const sources = { isReady: vi.fn(async () => camera.ready) } as unknown as LiveSourceRepositoryPort;
    const resolver = new LiveStreamSourceResolverService(media([camera]), sources);
    await expect(resolver.resolveById(camera.id)).rejects.toBeInstanceOf(LiveStreamSourceUnavailableError);
  });

  it('skips unavailable RTSP cameras when selecting the default source', async () => {
    const cameras = [
      { id: 'pending', name: 'Pending', type: 'rtsp', enabled: true },
      { id: 'ready', name: 'Ready', type: 'rtsp', enabled: true },
    ];
    const sources = {
      isReady: vi.fn(async (id: string) => id === 'ready'),
    } as unknown as LiveSourceRepositoryPort;
    const resolver = new LiveStreamSourceResolverService(media(cameras), sources);

    await expect(resolver.resolve()).resolves.toEqual({
      kind: 'rtsp', cameraId: 'ready', cameraName: 'Ready',
    });
  });

  it('resolves a configured RTSP source attached to a canonical Motion camera', async () => {
    const cameras = [{ id: 'front', name: 'Front', type: 'motion', enabled: true }];
    const mediaPort = media(cameras);
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32), currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials);
    await repository.rotate();
    const configure = new ConfigureLiveSourceUseCase(
      mediaPort,
      repository,
      credentials,
      { run: vi.fn().mockResolvedValue(undefined) } satisfies LiveSourceProbePort,
    );
    await configure.execute({
      cameraName: 'Front', url: 'rtsp://user:pass@camera.local/live',
      transport: 'tcp', tlsMode: 'none', profile: 'balanced',
    });
    const resolver = new LiveStreamSourceResolverService(mediaPort, repository);

    const expected = { kind: 'rtsp', cameraId: 'front', cameraName: 'Front' };
    await expect(resolver.resolve('Front')).resolves.toEqual(expected);
    await expect(resolver.resolveById('front')).resolves.toEqual(expected);
    await expect(resolver.resolve()).resolves.toEqual(expected);
  });

  it('keeps the historical first-Motion default when that camera has no ready RTSP source', async () => {
    const cameras = [
      { id: 'first', name: 'First', type: 'motion', enabled: true },
      { id: 'second', name: 'Second', type: 'motion', enabled: true },
    ];
    const sources = {
      isReady: vi.fn(async (id: string) => id === 'second'),
    } as unknown as LiveSourceRepositoryPort;

    await expect(new LiveStreamSourceResolverService(media(cameras), sources).resolve())
      .resolves.toEqual({
        kind: 'motion-mjpeg', cameraId: 'first', cameraName: 'First',
        upstreamUrl: 'http://127.0.0.1:8081/?action=stream',
      });
  });
});
