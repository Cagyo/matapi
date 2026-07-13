import { describe, expect, it, vi } from 'vitest';
import { MotionLiveSourceService } from '../../../src/camera/application/motion-live-source.service';
import { LiveStreamSourceUnavailableError } from '../../../src/camera/domain/errors/live-stream-source-unavailable.error';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';

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
    const resolver = new MotionLiveSourceService(media(cameras), sources);

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
    const resolver = new MotionLiveSourceService(media([camera]), sources);
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
    const resolver = new MotionLiveSourceService(media(cameras), sources);

    await expect(resolver.resolve()).resolves.toEqual({
      kind: 'rtsp', cameraId: 'ready', cameraName: 'Ready',
    });
  });
});
