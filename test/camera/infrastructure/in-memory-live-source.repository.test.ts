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
  it('reads one stored source back credential-free, unversioned and unverified', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32),
      currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials, async () => 'front_door');
    await repository.rotate();
    const source = LiveSource.create({
      cameraId: 'camera-1',
      url: 'rtsp://user:pass@cam.local/private?token=secret',
      ready: true,
    });
    await repository.save(source, credentials.encrypt(source.cameraId, source.credentialPayload()));

    const stored = await repository.findRedacted('camera-1');
    expect(stored).toEqual({
      cameraId: 'camera-1',
      cameraName: 'front_door',
      summary: source.summary(),
      hasCredential: true,
      revision: 0,
      verifiedAt: null,
      policyDigest: null,
    });
    expect(await repository.listRedacted()).toEqual([stored]);
    expect(await repository.findRedacted('camera-2')).toBeNull();
    expect(JSON.stringify(stored)).not.toMatch(/user|pass|private|token|secret/i);
  });

  it('reports a metadata-only source as credential-free', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32),
      currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials);
    await repository.saveMetadataBatch([
      LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/imported', ready: false }),
    ]);

    expect(await repository.findRedacted('camera-1')).toMatchObject({
      hasCredential: false,
      revision: 0,
      verifiedAt: null,
      policyDigest: null,
    });
  });
});
