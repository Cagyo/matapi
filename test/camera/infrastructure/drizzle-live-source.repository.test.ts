import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import type { AppDatabase } from '../../../src/database/database.module';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import { AesGcmLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { DrizzleLiveSourceRepository } from '../../../src/camera/infrastructure/drizzle-live-source.repository';
import { UnavailableLiveSourceCredentialAdapter } from '../../../src/camera/infrastructure/unavailable-live-source-credential.adapter';

describe('DrizzleLiveSourceRepository', () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  const oldKey = '11'.repeat(32);
  const newKey = '22'.repeat(32);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    db.insert(schema.cameras).values({
      id: 'camera-1',
      name: 'front_door',
      type: 'motion',
      config: null,
      enabled: true,
    }).run();
  });

  afterEach(() => sqlite.close());

  it('rejects normal credential writes until startup rotation succeeds', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({
      currentKey: oldKey,
      currentVersion: 1,
    });
    const repository = new DrizzleLiveSourceRepository(db, credentials);
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

  it('saves encrypted material, loads authenticated plaintext, lists metadata only, and cascades remove', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({ currentKey: oldKey, currentVersion: 1 });
    const repository = new DrizzleLiveSourceRepository(db, credentials);
    await repository.rotate();
    const source = LiveSource.create({
      cameraId: 'camera-1',
      url: 'rtsp://user:pass@cam.local/private?token=secret',
      ready: true,
    });
    await repository.save(source, credentials.encrypt(source.cameraId, source.credentialPayload()));

    expect(await repository.loadForStream('camera-1')).toMatchObject({
      source: { normalizedUrl: 'rtsp://cam.local', ready: true },
      credential: { primaryUrl: 'rtsp://user:pass@cam.local/private?token=secret' },
    });
    const listed = await repository.listRedacted();
    expect(listed).toEqual([
      expect.objectContaining({ cameraId: 'camera-1', cameraName: 'front_door' }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/user|pass|private|token|cipher|nonce|tag/i);

    await repository.remove('camera-1');
    expect(sqlite.prepare('select count(*) count from camera_live_credentials').get()).toEqual({ count: 0 });
  });

  it('metadata-only save removes credentials, remains not ready, and leaves the camera enabled', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({ currentKey: oldKey, currentVersion: 1 });
    const repository = new DrizzleLiveSourceRepository(db, credentials);
    const source = LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/live', ready: false });

    await repository.save(source, null);

    expect(await repository.loadForStream('camera-1')).toBeNull();
    expect(await repository.listRedacted()).toEqual([
      expect.objectContaining({ summary: expect.objectContaining({ ready: false }) }),
    ]);
    expect(sqlite.prepare('select enabled from cameras where id = ?').get('camera-1')).toEqual({ enabled: 1 });
  });

  it('rotates every old row atomically and rolls all rows back when one cannot authenticate', async () => {
    const oldCredentials = new AesGcmLiveSourceCredentialAdapter({ currentKey: oldKey, currentVersion: 1 });
    const seedRepository = new DrizzleLiveSourceRepository(db, oldCredentials);
    await seedRepository.rotate();
    const source = LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/live', ready: true });
    await seedRepository.save(source, oldCredentials.encrypt(source.cameraId, source.credentialPayload()));

    db.insert(schema.cameras).values({ id: 'camera-2', name: 'back_door', type: 'motion', config: null, enabled: true }).run();
    const second = LiveSource.create({ cameraId: 'camera-2', url: 'rtsp://back.local/live', ready: true });
    await seedRepository.save(second, oldCredentials.encrypt(second.cameraId, second.credentialPayload()));
    sqlite.prepare("update camera_live_credentials set auth_tag = 'broken' where camera_id = 'camera-2'").run();

    const rotating = new AesGcmLiveSourceCredentialAdapter({
      currentKey: newKey,
      currentVersion: 2,
      previousKeys: { 1: oldKey },
    });
    const repository = new DrizzleLiveSourceRepository(db, rotating);
    await expect(repository.rotate()).rejects.toMatchObject({ code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE' });

    const versions = sqlite.prepare('select camera_id, key_version from camera_live_credentials order by camera_id').all();
    expect(versions).toEqual([
      { camera_id: 'camera-1', key_version: 1 },
      { camera_id: 'camera-2', key_version: 1 },
    ]);
    await expect(
      repository.save(
        source,
        rotating.encrypt(source.cameraId, source.credentialPayload()),
      ),
    ).rejects.toMatchObject({
      code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE',
      message: 'Live source credential is unavailable',
    });
  });

  it.each([
    new AesGcmLiveSourceCredentialAdapter({
      currentKey: newKey,
      currentVersion: 1,
    }),
    new UnavailableLiveSourceCredentialAdapter(),
  ])(
    'fails startup when a matching-version row cannot authenticate',
    async (candidateCredentials) => {
      const oldCredentials = new AesGcmLiveSourceCredentialAdapter({
        currentKey: oldKey,
        currentVersion: 1,
      });
      const seedRepository = new DrizzleLiveSourceRepository(db, oldCredentials);
      await seedRepository.rotate();
      const source = LiveSource.create({
        cameraId: 'camera-1',
        url: 'rtsp://cam.local/live',
        ready: true,
      });
      await seedRepository.save(
        source,
        oldCredentials.encrypt(source.cameraId, source.credentialPayload()),
      );

      const repository = new DrizzleLiveSourceRepository(
        db,
        candidateCredentials,
      );
      await expect(repository.rotate()).rejects.toMatchObject({
        code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE',
      });
      await expect(
        repository.save(
          source,
          oldCredentials.encrypt(source.cameraId, source.credentialPayload()),
        ),
      ).rejects.toMatchObject({
        code: 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE',
      });
    },
  );

  it('rotates every old row to fresh current-version material that still decrypts', async () => {
    const oldCredentials = new AesGcmLiveSourceCredentialAdapter({ currentKey: oldKey, currentVersion: 1 });
    const seedRepository = new DrizzleLiveSourceRepository(db, oldCredentials);
    await seedRepository.rotate();
    const first = LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local/live', ready: true });
    await seedRepository.save(first, oldCredentials.encrypt(first.cameraId, first.credentialPayload()));
    db.insert(schema.cameras).values({ id: 'camera-2', name: 'back_door', type: 'motion', config: null, enabled: true }).run();
    const second = LiveSource.create({ cameraId: 'camera-2', url: 'rtsp://back.local/live', ready: true });
    await seedRepository.save(second, oldCredentials.encrypt(second.cameraId, second.credentialPayload()));
    const oldNonces = sqlite.prepare('select nonce from camera_live_credentials order by camera_id').all();

    const rotating = new AesGcmLiveSourceCredentialAdapter({
      currentKey: newKey,
      currentVersion: 2,
      previousKeys: { 1: oldKey },
    });
    const repository = new DrizzleLiveSourceRepository(db, rotating);
    await repository.rotate();

    expect(sqlite.prepare('select key_version from camera_live_credentials order by camera_id').all())
      .toEqual([{ key_version: 2 }, { key_version: 2 }]);
    expect(sqlite.prepare('select nonce from camera_live_credentials order by camera_id').all())
      .not.toEqual(oldNonces);
    await expect(repository.loadForStream('camera-1')).resolves.toMatchObject({
      credential: { primaryUrl: 'rtsp://cam.local/live' },
    });
    await expect(repository.loadForStream('camera-2')).resolves.toMatchObject({
      credential: { primaryUrl: 'rtsp://back.local/live' },
    });
  });

  it('writes a metadata import batch in one transaction', async () => {
    const credentials = new AesGcmLiveSourceCredentialAdapter({ currentKey: oldKey, currentVersion: 1 });
    const repository = new DrizzleLiveSourceRepository(db, credentials);
    const valid = LiveSource.create({ cameraId: 'camera-1', url: 'rtsp://cam.local', ready: false });
    const missing = LiveSource.create({ cameraId: 'missing-camera', url: 'rtsp://other.local', ready: false });

    await expect(repository.saveMetadataBatch([valid, missing])).rejects.toThrow();
    expect(sqlite.prepare('select count(*) count from camera_live_sources').get()).toEqual({ count: 0 });
  });
});
