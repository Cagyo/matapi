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
  it('versions every write and round-trips verification metadata', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32),
      currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials, async () => 'front_door');
    await repository.rotate();
    const verifiedAt = new Date('2026-08-20T10:00:00.000Z');
    const source = LiveSource.create({
      cameraId: 'camera-1',
      url: 'rtsp://user:pass@cam.local/private?token=secret',
      ready: true,
    });

    const created = await repository.save(
      source,
      credentials.encrypt(source.cameraId, source.credentialPayload()),
      { verifiedAt, policyDigest: 'sha256:0f0f' },
    );

    expect(created).toEqual({
      cameraId: 'camera-1',
      cameraName: 'front_door',
      summary: source.summary(),
      hasCredential: true,
      revision: 0,
      verifiedAt,
      policyDigest: 'sha256:0f0f',
    });
    expect(await repository.listRedacted()).toEqual([created]);

    const replaced = await repository.save(
      LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/other', ready: false }),
      null,
    );

    expect(replaced).toMatchObject({
      hasCredential: false,
      revision: 1,
      verifiedAt: null,
      policyDigest: null,
    });
    expect(await repository.listRedacted()).toEqual([replaced]);
    expect(JSON.stringify(replaced)).not.toMatch(/user|pass|private|token|secret/i);
  });

  it('versions a metadata import over a verified source and drops its verification', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: '11'.repeat(32),
      currentVersion: 1,
    });
    const repository = new InMemoryLiveSourceRepository(credentials);
    await repository.rotate();
    const source = LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/live', ready: true });
    await repository.save(source, credentials.encrypt(source.cameraId, source.credentialPayload()), {
      verifiedAt: new Date('2026-08-20T10:00:00.000Z'),
      policyDigest: 'sha256:0f0f',
    });

    await repository.saveMetadataBatch([
      LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/imported', ready: false }),
    ]);

    expect(await repository.listRedacted()).toEqual([
      expect.objectContaining({ revision: 1, verifiedAt: null, policyDigest: null, hasCredential: false }),
    ]);
  });
});
