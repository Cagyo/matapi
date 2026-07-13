import { describe, expect, it } from 'vitest';
import { OpenLiveStreamUseCase } from '../../../src/camera/application/open-live-stream.use-case';
import { FeatureLiveStreamCapabilityAdapter } from '../../../src/camera/infrastructure/feature-live-stream-capability.adapter';

describe('live-stream capability', () => {
  it('refuses a live request when the Quick Tunnel capability is unavailable', async () => {
    let sourceResolutions = 0;
    const useCase = new OpenLiveStreamUseCase(
      {
        resolve: async () => {
          sourceResolutions += 1;
          throw new Error('source must not be resolved');
        },
      } as never,
      { open: async () => { throw new Error('gateway must not start'); } } as never,
      { isAvailable: async () => false },
    );

    await expect(useCase.execute({ telegramId: 1 })).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(sourceResolutions).toBe(0);
  });

  it('requires enabled config plus installed and enabled feature state', async () => {
    const features = {
      listAll: async () => [{ name: 'rtsp', enabled: true, installed: true, config: null }],
    };

    await expect(new FeatureLiveStreamCapabilityAdapter(
      features,
      false,
      async () => true,
    ).isAvailable()).resolves.toBe(false);
    await expect(new FeatureLiveStreamCapabilityAdapter(
      { listAll: async () => [{ name: 'rtsp', enabled: true, installed: false, config: null }] },
      true,
      async () => true,
    ).isAvailable()).resolves.toBe(false);
  });

  it('requires the installed cloudflared executable probe', async () => {
    const features = {
      listAll: async () => [{ name: 'rtsp', enabled: true, installed: true, config: null }],
    };

    await expect(new FeatureLiveStreamCapabilityAdapter(
      features,
      true,
      async () => false,
    ).isAvailable()).resolves.toBe(false);
  });
});
