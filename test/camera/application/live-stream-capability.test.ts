import { describe, expect, it } from 'vitest';
import { OpenLiveStreamUseCase } from '../../../src/camera/application/open-live-stream.use-case';
import { FeatureLiveStreamCapabilityAdapter } from '../../../src/camera/infrastructure/feature-live-stream-capability.adapter';

describe('live-stream capability', () => {
  it('refuses a resolved live request when the Quick Tunnel capability is unavailable', async () => {
    let sourceResolutions = 0;
    const useCase = new OpenLiveStreamUseCase(
      {
        resolve: async () => {
          sourceResolutions += 1;
          return {
            kind: 'motion-mjpeg',
            cameraId: 'front',
            cameraName: 'Front',
            upstreamUrl: 'http://127.0.0.1:8081/?action=stream',
          };
        },
      } as never,
      { open: async () => { throw new Error('gateway must not start'); } } as never,
      { isAvailable: async () => false },
    );

    await expect(useCase.execute({ telegramId: 1 })).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(sourceResolutions).toBe(1);
  });

  it('requires enabled config plus installed and enabled feature state', async () => {
    const features = {
      listAll: async () => [{ name: 'rtsp', enabled: true, installed: true, config: null }],
    };

    await expect(new FeatureLiveStreamCapabilityAdapter(
      features,
      false,
      async () => true,
    ).isAvailable('rtsp')).resolves.toBe(false);
    await expect(new FeatureLiveStreamCapabilityAdapter(
      { listAll: async () => [{ name: 'rtsp', enabled: true, installed: false, config: null }] },
      true,
      async () => true,
    ).isAvailable('rtsp')).resolves.toBe(false);
  });

  it('requires the installed cloudflared executable probe', async () => {
    const features = {
      listAll: async () => [{ name: 'rtsp', enabled: true, installed: true, config: null }],
    };

    await expect(new FeatureLiveStreamCapabilityAdapter(
      features,
      true,
      async () => false,
    ).isAvailable('rtsp')).resolves.toBe(false);
  });

  it('keeps Motion/MJPEG available when only the RTSP feature is disabled', async () => {
    const capability = new FeatureLiveStreamCapabilityAdapter(
      { listAll: async () => [{ name: 'rtsp', enabled: false, installed: true, config: null }] },
      true,
      async () => true,
    );

    await expect(capability.isAvailable('motion-mjpeg')).resolves.toBe(true);
    await expect(capability.isAvailable('rtsp')).resolves.toBe(false);
  });
});
