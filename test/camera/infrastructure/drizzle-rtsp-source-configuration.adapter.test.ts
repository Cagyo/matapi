import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../../src/database/database.module';
import * as schema from '../../../src/database/schema';
import { cameraNameKey } from '../../../src/camera/domain/camera-name-key';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { EncryptedLiveSourceCredential } from '../../../src/camera/domain/ports/live-source-credential.port';
import { DrizzleRtspSourceConfigurationAdapter } from '../../../src/camera/infrastructure/drizzle-rtsp-source-configuration.adapter';

const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1?token=abcdef';
const REPLACEMENT_URL = 'rtsp://operator:hunter2@other.local/stream2';

/** Ciphertext stand-in: the adapter must never encrypt or inspect it. */
function credential(keyVersion = 1): EncryptedLiveSourceCredential {
  return { ciphertext: 'ct', nonce: 'nc', authTag: 'at', keyVersion };
}

describe('DrizzleRtspSourceConfigurationAdapter', () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let adapter: DrizzleRtspSourceConfigurationAdapter;
  const verifiedAt = new Date('2026-08-20T10:30:00.500Z');

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    adapter = new DrizzleRtspSourceConfigurationAdapter(db);
  });

  afterEach(() => sqlite.close());

  function source(cameraId: string, url = SECRET_URL): LiveSource {
    return LiveSource.create({ cameraId, url, transport: 'tcp', profile: 'eco', ready: true });
  }

  function newCamera(id: string, name: string, url = SECRET_URL) {
    return {
      source: source(id, url),
      credential: credential(),
      policyDigest: 'digest-1',
      verifiedAt,
      camera: { id, name, nameKey: cameraNameKey(name) },
    };
  }

  function insertCamera(id: string, name: string, type: string): void {
    sqlite
      .prepare('INSERT INTO cameras (id, name, name_key, type, config, enabled) VALUES (?, ?, ?, ?, NULL, 1)')
      .run(id, name, cameraNameKey(name), type);
  }

  function rows(table: string): Record<string, unknown>[] {
    return sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
  }

  /** Fails the third write of a create without any production seam. */
  function failCredentialWrites(): void {
    sqlite.exec(
      `CREATE TRIGGER reject_credentials BEFORE INSERT ON camera_live_credentials
       BEGIN SELECT RAISE(ABORT, 'injected credential failure'); END;`,
    );
  }

  describe('createCamera', () => {
    it('writes camera, source and credential in one transaction and returns a redacted view', () => {
      const result = adapter.createCamera(newCamera('cam-1', ' Front Door '));

      expect(result).toEqual({
        cameraId: 'cam-1',
        cameraName: ' Front Door ',
        summary: {
          scheme: 'rtsp',
          host: 'cam.local',
          transport: 'tcp',
          tlsMode: 'none',
          profile: 'eco',
          substreamHost: null,
          ready: true,
        },
        hasCredential: true,
        revision: 0,
        verifiedAt,
        policyDigest: 'digest-1',
      });
      expect(JSON.stringify(result)).not.toMatch(/operator|hunter2|abcdef/u);
      expect(rows('cameras')).toEqual([
        { id: 'cam-1', name: ' Front Door ', name_key: 'front door', type: 'rtsp', config: null, enabled: 1 },
      ]);
      expect(rows('camera_live_sources')[0]).toMatchObject({
        camera_id: 'cam-1',
        normalized_url: 'rtsp://cam.local',
        ready: 1,
        revision: 0,
        policy_digest: 'digest-1',
      });
      expect(rows('camera_live_credentials')).toEqual([
        { camera_id: 'cam-1', ciphertext: 'ct', nonce: 'nc', auth_tag: 'at', key_version: 1 },
      ]);
    });

    it('stores the verification timestamp as epoch milliseconds beside created_at', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      const row = rows('camera_live_sources')[0];
      expect(row.verified_at).toBe(verifiedAt.getTime());
      expect(row.verified_at).toBeGreaterThan(1_000_000_000_000);
      expect(String(row.created_at).length).toBe(String(row.verified_at).length);
    });

    it('returns synchronously rather than through a promise', () => {
      expect(adapter.createCamera(newCamera('cam-1', 'Front Door'))).not.toBeInstanceOf(Promise);
    });

    it('rejects a name key that is not the canonical form of the name', () => {
      const input = newCamera('cam-1', 'Front Door');

      expect(() =>
        adapter.createCamera({ ...input, camera: { ...input.camera, nameKey: 'Front Door' } }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
      expect(rows('cameras')).toEqual([]);
    });

    it('rejects a source addressed to a different camera than the one being created', () => {
      const input = newCamera('cam-1', 'Front Door');

      expect(() =>
        adapter.createCamera({ ...input, source: source('cam-2') }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
      expect(rows('cameras')).toEqual([]);
    });

    it('maps a camera identifier collision to a typed error and writes nothing', () => {
      insertCamera('cam-1', 'Garden', 'motion');

      expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
        expect.objectContaining({ code: 'CAMERA_ID_COLLISION' }),
      );
      expect(rows('cameras')).toHaveLength(1);
      expect(rows('camera_live_sources')).toEqual([]);
    });

    it('maps a canonical name collision to a name-taken error that names no camera', () => {
      insertCamera('cam-0', 'front door', 'motion');

      const failure = (() => {
        try {
          adapter.createCamera(newCamera('cam-1', ' FRONT DOOR '));
          return null;
        } catch (error) {
          return error as Error;
        }
      })();

      expect(failure).toMatchObject({ code: 'CAMERA_NAME_TAKEN' });
      expect(failure?.message).not.toMatch(/front|door/iu);
      expect(rows('cameras')).toHaveLength(1);
    });

    it('maps an exact display-name collision to the same name-taken error', () => {
      insertCamera('cam-0', 'Front Door', 'motion');

      expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
        expect.objectContaining({ code: 'CAMERA_NAME_TAKEN' }),
      );
    });

    it('rolls camera and source back when the credential write fails', () => {
      failCredentialWrites();

      expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
        /injected credential failure/u,
      );
      expect(rows('cameras')).toEqual([]);
      expect(rows('camera_live_sources')).toEqual([]);
      expect(rows('camera_live_credentials')).toEqual([]);
    });

    it('lets an unrelated constraint failure propagate unmapped', () => {
      sqlite.exec(
        `CREATE TRIGGER reject_cameras BEFORE INSERT ON cameras
         BEGIN SELECT RAISE(ABORT, 'unrelated failure'); END;`,
      );

      const failure = (() => {
        try {
          adapter.createCamera(newCamera('cam-1', 'Front Door'));
          return null;
        } catch (error) {
          return error as { code?: string };
        }
      })();

      expect(failure?.code).not.toBe('CAMERA_ID_COLLISION');
      expect(failure?.code).not.toBe('CAMERA_NAME_TAKEN');
      expect(failure?.code).toMatch(/^SQLITE_/u);
    });
  });

  describe('attach', () => {
    beforeEach(() => insertCamera('cam-1', 'Hallway', 'motion'));

    it('adds a verified source to an existing camera at revision zero', () => {
      const result = adapter.attach({
        source: source('cam-1'),
        credential: credential(),
        policyDigest: 'digest-1',
        verifiedAt,
        cameraId: 'cam-1',
      });

      expect(result).toMatchObject({
        cameraId: 'cam-1',
        cameraName: 'Hallway',
        hasCredential: true,
        revision: 0,
        verifiedAt,
        policyDigest: 'digest-1',
      });
      expect(JSON.stringify(result)).not.toMatch(/operator|hunter2|abcdef/u);
      expect(rows('camera_live_sources')).toHaveLength(1);
      expect(rows('cameras')[0]).toMatchObject({ type: 'motion' });
    });

    it('rejects a second attach to the same camera as a state change', () => {
      const input = {
        source: source('cam-1'),
        credential: credential(),
        policyDigest: 'digest-1',
        verifiedAt,
        cameraId: 'cam-1',
      };
      adapter.attach(input);

      expect(() => adapter.attach(input)).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(rows('camera_live_sources')).toHaveLength(1);
    });

    it('rejects an attach whose camera disappeared', () => {
      expect(() =>
        adapter.attach({
          source: source('cam-gone'),
          credential: credential(),
          policyDigest: 'digest-1',
          verifiedAt,
          cameraId: 'cam-gone',
        }),
      ).toThrow(expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }));
    });

    it('rejects a source addressed to a different camera', () => {
      expect(() =>
        adapter.attach({
          source: source('cam-2'),
          credential: credential(),
          policyDigest: 'digest-1',
          verifiedAt,
          cameraId: 'cam-1',
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
    });

    it('rolls the source back when the credential write fails', () => {
      failCredentialWrites();

      expect(() =>
        adapter.attach({
          source: source('cam-1'),
          credential: credential(),
          policyDigest: 'digest-1',
          verifiedAt,
          cameraId: 'cam-1',
        }),
      ).toThrow(/injected credential failure/u);
      expect(rows('camera_live_sources')).toEqual([]);
    });
  });

  describe('replace', () => {
    beforeEach(() => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));
    });

    function replacement(expectedRevision: number) {
      return {
        source: source('cam-1', REPLACEMENT_URL),
        credential: credential(2),
        policyDigest: 'digest-2',
        verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
        cameraId: 'cam-1',
        expectedRevision,
      };
    }

    it('swaps the source at the expected revision and advances it by one', () => {
      const result = adapter.replace(replacement(0));

      expect(result).toMatchObject({
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        revision: 1,
        policyDigest: 'digest-2',
        verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
        summary: expect.objectContaining({ host: 'other.local' }),
      });
      expect(JSON.stringify(result)).not.toMatch(/operator|hunter2/u);
      expect(rows('camera_live_sources')[0]).toMatchObject({
        normalized_url: 'rtsp://other.local',
        revision: 1,
        policy_digest: 'digest-2',
        verified_at: new Date('2026-08-21T09:00:00.250Z').getTime(),
      });
      expect(rows('camera_live_credentials')[0]).toMatchObject({ key_version: 2 });
    });

    it('rejects a stale revision and leaves the stored source untouched', () => {
      adapter.replace(replacement(0));

      expect(() => adapter.replace(replacement(0))).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(rows('camera_live_sources')[0]).toMatchObject({
        normalized_url: 'rtsp://other.local',
        revision: 1,
      });
    });

    it('rejects a replacement for a camera with no stored source', () => {
      insertCamera('cam-2', 'Hallway', 'motion');

      expect(() =>
        adapter.replace({ ...replacement(0), source: source('cam-2', REPLACEMENT_URL), cameraId: 'cam-2' }),
      ).toThrow(expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }));
    });

    it('rolls the source update back when the credential write fails', () => {
      failCredentialWrites();

      expect(() => adapter.replace(replacement(0))).toThrow(/injected credential failure/u);
      expect(rows('camera_live_sources')[0]).toMatchObject({
        normalized_url: 'rtsp://cam.local',
        revision: 0,
        policy_digest: 'digest-1',
      });
    });
  });

  describe('remove', () => {
    it('deletes the whole camera when the transaction reads type rtsp', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({ removed: 'camera' });
      expect(rows('cameras')).toEqual([]);
      expect(rows('camera_live_sources')).toEqual([]);
      expect(rows('camera_live_credentials')).toEqual([]);
    });

    it('preserves a non-rtsp camera and removes only its source', () => {
      insertCamera('cam-1', 'Hallway', 'motion');
      adapter.attach({
        source: source('cam-1'),
        credential: credential(),
        policyDigest: 'digest-1',
        verifiedAt,
        cameraId: 'cam-1',
      });

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({ removed: 'source' });
      expect(rows('cameras')).toHaveLength(1);
      expect(rows('camera_live_sources')).toEqual([]);
      expect(rows('camera_live_credentials')).toEqual([]);
    });

    it('ignores a caller-supplied delete decision and trusts the stored type', () => {
      insertCamera('cam-1', 'Hallway', 'motion');
      adapter.attach({
        source: source('cam-1'),
        credential: credential(),
        policyDigest: 'digest-1',
        verifiedAt,
        cameraId: 'cam-1',
      });

      const forced = { cameraId: 'cam-1', expectedRevision: 0, removed: 'camera' as const };
      expect(adapter.remove(forced)).toEqual({ removed: 'source' });
      expect(rows('cameras')).toHaveLength(1);
    });

    it('rejects a stale revision and deletes nothing', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      expect(() => adapter.remove({ cameraId: 'cam-1', expectedRevision: 3 })).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(rows('cameras')).toHaveLength(1);
      expect(rows('camera_live_sources')).toHaveLength(1);
      expect(rows('camera_live_credentials')).toHaveLength(1);
    });

    it('rejects removal for a camera that is already gone', () => {
      expect(() => adapter.remove({ cameraId: 'cam-gone', expectedRevision: 0 })).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
    });
  });
});
