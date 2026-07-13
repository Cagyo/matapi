import { describe, expect, it, vi } from 'vitest';
import { ConfigureLiveSourceUseCase } from '../../../src/camera/application/configure-live-source.use-case';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import type { LiveSourceProbePort } from '../../../src/camera/domain/ports/live-source-probe.port';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';

const camera = {
  id: 'camera-1',
  name: 'front_door',
  type: 'motion',
  config: null,
  enabled: true,
};

async function fixture() {
  const credentials = new AesGcmLiveSourceCredentialAdapter({
    currentKey: '11'.repeat(32),
    currentVersion: 1,
  });
  const repository = new InMemoryLiveSourceRepository(credentials);
  await repository.rotate();
  const probe: LiveSourceProbePort = { run: vi.fn().mockResolvedValue(undefined) };
  const media = {
    findCameraByName: vi.fn().mockResolvedValue(camera),
  } as unknown as MediaRepositoryPort;
  return {
    repository,
    probe,
    useCase: new ConfigureLiveSourceUseCase(media, repository, credentials, probe),
  };
}

describe('ConfigureLiveSourceUseCase', () => {
  it('probes, encrypts and saves the same validated source settings', async () => {
    const { useCase, probe, repository } = await fixture();

    const result = await useCase.execute({
      cameraName: 'front_door',
      url: 'rtsp://user:pass@cam.local/private?token=secret',
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
    });

    expect(probe.run).toHaveBeenCalledOnce();
    const probed = vi.mocked(probe.run).mock.calls[0][0];
    const loaded = await repository.loadForStream('camera-1');
    expect(loaded?.source).toBe(probed);
    expect(loaded?.source.settings).toMatchObject({ transport: 'tcp', profile: 'eco' });
    expect(loaded?.credential.primaryUrl).toContain('/private?token=secret');
    expect(JSON.stringify(result)).not.toMatch(/user|pass|private|token|secret/i);
  });

  it('never saves when probing fails and rejects compatibility fingerprints', async () => {
    const { useCase, probe, repository } = await fixture();
    vi.mocked(probe.run).mockRejectedValueOnce(new Error('probe failed'));

    await expect(
      useCase.execute({
        cameraName: 'front_door',
        url: 'rtsp://cam.local/live',
        transport: 'tcp',
        tlsMode: 'none',
        profile: 'eco',
      }),
    ).rejects.toThrow();
    expect(await repository.listRedacted()).toEqual([]);

    await expect(
      useCase.execute({
        cameraName: 'front_door',
        url: 'rtsps://cam.local/live',
        transport: 'tcp',
        tlsMode: 'strict',
        certificateFingerprint: 'sha256:legacy',
        profile: 'eco',
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_LIVE_SOURCE' });
  });
});
