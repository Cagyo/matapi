import { describe, expect, it, vi } from 'vitest';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';
import { ImportCameraLiveSourcesUseCase } from '../../../src/telegram/application/import-camera-live-sources.use-case';
import { validateLiveSourceConfig } from '../../../src/telegram/domain/live-source-config-import';

const metadata = {
  camera_name: 'front_door',
  scheme: 'rtsp' as const,
  host: 'cam.local:554',
  transport: 'tcp' as const,
  tls_mode: 'none' as const,
  profile: 'eco' as const,
  ready: false as const,
};

describe('ImportCameraLiveSourcesUseCase', () => {
  it('prepares read-only then atomically writes not-ready metadata without credentials', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({ currentKey: '11'.repeat(32), currentVersion: 1 });
    const repository = new InMemoryLiveSourceRepository(credentials);
    const media = {
      findCameraByName: vi.fn().mockResolvedValue({ id: 'camera-1', name: 'front_door', type: 'motion', config: null, enabled: true }),
    } as unknown as MediaRepositoryPort;
    const useCase = new ImportCameraLiveSourcesUseCase(media, repository);

    const plan = await useCase.prepare([metadata]);
    expect(await repository.listRedacted()).toEqual([]);

    await useCase.commit(plan);
    expect(await repository.listRedacted()).toEqual([
      expect.objectContaining({ summary: expect.objectContaining({ ready: false }) }),
    ]);
    expect(await repository.loadForStream('camera-1')).toBeNull();
  });

  it('rejects non-null fingerprints, secret-shaped extra fields, and non-canonical hosts', async () => {
    expect(validateLiveSourceConfig([{ ...metadata, certificate_fingerprint: null }]).ok).toBe(false);
    expect(validateLiveSourceConfig([{ ...metadata, url: 'rtsp://user:pass@cam/private' }]).ok).toBe(false);

    const repository = new InMemoryLiveSourceRepository(
      new AesGcmLiveSourceCredentialAdapter({ currentKey: '11'.repeat(32), currentVersion: 1 }),
    );
    const media = { findCameraByName: vi.fn().mockResolvedValue({ id: 'camera-1' }) } as unknown as MediaRepositoryPort;
    await expect(
      new ImportCameraLiveSourcesUseCase(media, repository).prepare([
        { ...metadata, host: 'cam.local/private' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_LIVE_SOURCE' });
  });
});
