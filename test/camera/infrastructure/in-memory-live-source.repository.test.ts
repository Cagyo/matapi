import { describe, expect, it } from 'vitest';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';

describe('InMemoryLiveSourceRepository', () => {
  it('rejects normal credential writes until startup rotation succeeds', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32),
      currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials);
    const source = LiveSource.create({
      cameraId: 'camera-1',
      url: 'rtsp://cam.local/live',
      ready: true,
    });

    await expect(
      repository.save(
        source,
        credentials.encrypt(source.cameraId, source.credentialPayload()),
      ),
    ).rejects.toMatchObject({
      code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE',
      message: 'Live source credential is unavailable',
    });
  });

  it('does not load a credential-backed source that is not ready', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32),
      currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials);
    await repository.rotate();
    const source = LiveSource.create({
      cameraId: 'camera-1',
      url: 'rtsp://cam.local/live',
      ready: false,
    });
    await repository.save(
      source,
      credentials.encrypt(source.cameraId, source.credentialPayload()),
    );

    await expect(repository.loadForStream(source.cameraId)).resolves.toBeNull();
  });
});
