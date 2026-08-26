import { beforeEach, describe, expect, it } from 'vitest';
import { cameraNameKey } from '../../../src/camera/domain/camera-name-key';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { EncryptedLiveSourceCredential } from '../../../src/camera/domain/ports/live-source-credential.port';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../../src/camera/infrastructure/in-memory-live-source.repository';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';
import { InMemoryRtspSourceConfigurationAdapter } from '../../../src/camera/infrastructure/in-memory-rtsp-source-configuration.adapter';

const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1?token=abcdef';

function credential(): EncryptedLiveSourceCredential {
  return { ciphertext: 'ct', nonce: 'nc', authTag: 'at', keyVersion: 1 };
}

function source(cameraId: string, url = SECRET_URL): LiveSource {
  return LiveSource.create({ cameraId, url, transport: 'tcp', profile: 'eco', ready: true });
}

/**
 * Store-sharing behaviour only. The semantics both adapters share live in
 * `rtsp-source-configuration.contract.test.ts`.
 */
describe('InMemoryRtspSourceConfigurationAdapter', () => {
  const verifiedAt = new Date('2026-08-20T10:30:00.500Z');

  function newCamera(id: string, name: string) {
    return {
      source: source(id),
      credential: credential(),
      policyDigest: 'digest-1',
      verifiedAt,
      camera: { id, name, nameKey: cameraNameKey(name) },
    };
  }

  describe('standalone stores', () => {
    let adapter: InMemoryRtspSourceConfigurationAdapter;

    beforeEach(() => {
      adapter = new InMemoryRtspSourceConfigurationAdapter();
    });

    it('keeps only credential-free derived fields, never the plaintext entity', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      const stored = adapter.sources();
      expect(stored).toEqual([
        {
          cameraId: 'cam-1',
          summary: expect.objectContaining({ host: 'cam.local' }),
          revision: 0,
          verifiedAt,
          policyDigest: 'digest-1',
          hasCredential: true,
        },
      ]);
      expect(JSON.stringify(stored)).not.toMatch(/operator|hunter2|abcdef/u);
    });

    it('copies the verification timestamp rather than aliasing the caller’s date', () => {
      const mutable = new Date(verifiedAt.getTime());
      const result = adapter.createCamera({ ...newCamera('cam-1', 'Front Door'), verifiedAt: mutable });

      mutable.setFullYear(1999);

      expect(result.verifiedAt).toEqual(verifiedAt);
      expect(adapter.sources()[0].verifiedAt).toEqual(verifiedAt);
    });
  });

  describe('stores shared with the stub repositories', () => {
    let media: InMemoryMediaRepository;
    let sources: InMemoryLiveSourceRepository;
    let adapter: InMemoryRtspSourceConfigurationAdapter;

    beforeEach(() => {
      media = new InMemoryMediaRepository();
      sources = new InMemoryLiveSourceRepository(
        new AesGcmLiveSourceCredentialAdapter({ currentKey: '11'.repeat(32), currentVersion: 1 }),
      );
      adapter = new InMemoryRtspSourceConfigurationAdapter(media, sources);
    });

    it('makes a created camera visible to the media repository', async () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      await expect(media.listCameras()).resolves.toEqual([
        { id: 'cam-1', name: 'Front Door', type: 'rtsp-source', config: null, enabled: true },
      ]);
      await expect(media.findCameraByName(' FRONT DOOR ')).resolves.toMatchObject({ id: 'cam-1' });
    });

    it('makes a created source visible to the live-source repository', async () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      await expect(sources.findRedacted('cam-1')).resolves.toMatchObject({
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        hasCredential: true,
        revision: 0,
        verifiedAt,
        policyDigest: 'digest-1',
      });
      expect(await sources.listRedacted()).toHaveLength(1);
    });

    it('decides name uniqueness against rows seeded through the media repository', () => {
      media.seedCameras([
        { id: 'seeded', name: 'front door', type: 'motion', config: null, enabled: true },
      ]);

      expect(() => adapter.createCamera(newCamera('cam-1', ' FRONT DOOR '))).toThrow(
        expect.objectContaining({ code: 'CAMERA_NAME_TAKEN' }),
      );
    });

    it('attaches to a camera the media repository already knows', () => {
      media.seedCameras([
        { id: 'seeded', name: 'Hallway', type: 'motion', config: null, enabled: true },
      ]);

      const result = adapter.attach({
        source: source('seeded'),
        credential: credential(),
        policyDigest: 'digest-1',
        verifiedAt,
        cameraId: 'seeded',
      });

      expect(result).toMatchObject({ cameraId: 'seeded', cameraName: 'Hallway', revision: 0 });
    });

    it('refuses to attach to a camera the media repository reports as disabled', () => {
      media.seedCameras([
        { id: 'seeded', name: 'Hallway', type: 'motion', config: null, enabled: false },
      ]);

      expect(() =>
        adapter.attach({
          source: source('seeded'),
          credential: credential(),
          policyDigest: 'digest-1',
          verifiedAt,
          cameraId: 'seeded',
        }),
      ).toThrow(expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }));
    });

    it('sees an imported, credential-free source the repository stored', async () => {
      // Only the shared wiring can reach this pre-state: `save`/`saveMetadataBatch`
      // write the same map. SQLite behaves the same way, so a use case that
      // attaches to a camera holding imported metadata must be blocked here too.
      media.seedCameras([
        { id: 'cam-1', name: 'Hallway', type: 'motion', config: null, enabled: true },
      ]);
      await sources.save(
        LiveSource.create({ cameraId: 'cam-1', url: 'rtsp://cam.local', ready: false }),
        null,
      );

      expect(adapter.sources()).toEqual([
        expect.objectContaining({ cameraId: 'cam-1', hasCredential: false, revision: 0 }),
      ]);
      expect(() =>
        adapter.attach({
          source: source('cam-1'),
          credential: credential(),
          policyDigest: 'digest-1',
          verifiedAt,
          cameraId: 'cam-1',
        }),
      ).toThrow(expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }));
    });

    it('de-attributes recorded media when it removes the camera it created', async () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));
      await media.createEvent('cam-1', new Date('2026-08-20T11:00:00.000Z'));

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({
        removed: 'camera',
      });
      await expect(media.listCameras()).resolves.toEqual([]);
      const events = await media.listLatestEvents(10);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ cameraId: null, cameraName: null });
      await expect(sources.findRedacted('cam-1')).resolves.toBeNull();
    });
  });
});
