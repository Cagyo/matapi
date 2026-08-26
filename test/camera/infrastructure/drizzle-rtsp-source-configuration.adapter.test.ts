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

/**
 * Storage-level behaviour only. The semantics both adapters share live in
 * `rtsp-source-configuration.contract.test.ts`.
 */
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

  function attachment(cameraId: string) {
    return {
      source: source(cameraId),
      credential: credential(),
      policyDigest: 'digest-1',
      verifiedAt,
      cameraId,
    };
  }

  function insertCamera(id: string, name: string, type: string): void {
    sqlite
      .prepare('INSERT INTO cameras (id, name, name_key, type, config, enabled) VALUES (?, ?, ?, ?, NULL, 1)')
      .run(id, name, cameraNameKey(name), type);
  }

  /** Legacy rows predate the canonical key column, so it stays null. */
  function insertKeylessCamera(id: string, name: string): void {
    sqlite
      .prepare('INSERT INTO cameras (id, name, type, config, enabled) VALUES (?, ?, ?, NULL, 1)')
      .run(id, name, 'motion');
  }

  function rows(table: string): Record<string, unknown>[] {
    return sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
  }

  /** Fails the credential write without any production seam. */
  function failCredentialWrites(): void {
    sqlite.exec(
      `CREATE TRIGGER reject_credentials BEFORE INSERT ON camera_live_credentials
       BEGIN SELECT RAISE(ABORT, 'injected credential failure'); END;`,
    );
  }

  describe('column-level storage', () => {
    it('writes camera, source and credential rows in full', () => {
      adapter.createCamera(newCamera('cam-1', ' Front Door '));

      expect(rows('cameras')).toEqual([
        { id: 'cam-1', name: ' Front Door ', name_key: 'front door', type: 'rtsp-source', config: null, enabled: 1 },
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

    it('rewrites every source column and the credential on a replacement', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      adapter.replace({
        source: source('cam-1', REPLACEMENT_URL),
        credential: credential(2),
        policyDigest: 'digest-2',
        verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
        cameraId: 'cam-1',
        expectedRevision: 0,
      });

      expect(rows('camera_live_sources')[0]).toMatchObject({
        normalized_url: 'rtsp://other.local',
        revision: 1,
        policy_digest: 'digest-2',
        verified_at: new Date('2026-08-21T09:00:00.250Z').getTime(),
      });
      expect(rows('camera_live_credentials')[0]).toMatchObject({ key_version: 2 });
    });
  });

  describe('transaction atomicity', () => {
    it('rolls camera and source back when the credential write fails on create', () => {
      failCredentialWrites();

      expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
        /injected credential failure/u,
      );
      expect(rows('cameras')).toEqual([]);
      expect(rows('camera_live_sources')).toEqual([]);
      expect(rows('camera_live_credentials')).toEqual([]);
    });

    it('rolls the source back when the credential write fails on attach', () => {
      insertCamera('cam-1', 'Hallway', 'motion');
      failCredentialWrites();

      expect(() => adapter.attach(attachment('cam-1'))).toThrow(/injected credential failure/u);
      expect(rows('camera_live_sources')).toEqual([]);
    });

    it('rolls the source update back when the credential write fails on replace', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));
      failCredentialWrites();

      expect(() =>
        adapter.replace({
          source: source('cam-1', REPLACEMENT_URL),
          credential: credential(2),
          policyDigest: 'digest-2',
          verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
          cameraId: 'cam-1',
          expectedRevision: 0,
        }),
      ).toThrow(/injected credential failure/u);
      expect(rows('camera_live_sources')[0]).toMatchObject({
        normalized_url: 'rtsp://cam.local',
        revision: 0,
        policy_digest: 'digest-1',
      });
    });
  });

  describe('constraint mapping', () => {
    it('maps an exact display-name collision through the unique index', () => {
      insertCamera('cam-0', 'Front Door', 'motion');

      expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
        expect.objectContaining({ code: 'CAMERA_NAME_TAKEN' }),
      );
    });

    it('lets an unrelated constraint failure propagate unmapped', () => {
      sqlite.exec(
        `CREATE TRIGGER reject_cameras BEFORE INSERT ON cameras
         BEGIN SELECT RAISE(ABORT, 'unrelated failure'); END;`,
      );

      let failure: { code?: string } | null = null;
      try {
        adapter.createCamera(newCamera('cam-1', 'Front Door'));
      } catch (error) {
        failure = error as { code?: string };
      }

      expect(failure?.code).not.toBe('CAMERA_ID_COLLISION');
      expect(failure?.code).not.toBe('CAMERA_NAME_TAKEN');
      expect(failure?.code).toMatch(/^SQLITE_/u);
    });
  });

  describe('legacy rows the name-key backfill has not claimed', () => {
    it('refuses a create whose canonical name matches a keyless row', () => {
      // Null name keys repeat freely in a unique index, so the index alone
      // would let both rows coexist under one logical name.
      insertKeylessCamera('legacy', 'Front Door');

      const failure = (() => {
        try {
          adapter.createCamera(newCamera('cam-1', 'front door'));
          return null;
        } catch (error) {
          return error as Error;
        }
      })();

      expect(failure).toMatchObject({ code: 'CAMERA_NAME_TAKEN' });
      expect(failure?.message).not.toMatch(/front|door/iu);
      expect(rows('cameras')).toHaveLength(1);
      expect(rows('camera_live_sources')).toEqual([]);
    });

    it('allows a create whose canonical name differs from every keyless row', () => {
      insertKeylessCamera('legacy', 'Terrassentür');

      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      expect(rows('cameras')).toHaveLength(2);
    });
  });

  describe('removal of a camera with recorded media', () => {
    function insertMotionEvent(cameraId: string): void {
      sqlite
        .prepare('INSERT INTO motion_events (camera_id, started_at, video_path) VALUES (?, ?, ?)')
        .run(cameraId, 1_700_000_000, '/motion/clip.mp4');
    }

    it('de-attributes recorded media instead of failing on the foreign key', () => {
      // `motion_events.camera_id` references `cameras.id` with no ON DELETE
      // action, and `RecordMotionStartUseCase` falls back to the first camera
      // row, so any port-created camera can end up holding events.
      adapter.createCamera(newCamera('cam-1', 'Front Door'));
      insertMotionEvent('cam-1');

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({
        removed: 'camera',
      });
      expect(rows('cameras')).toEqual([]);
      expect(rows('camera_live_sources')).toEqual([]);
      expect(rows('camera_live_credentials')).toEqual([]);
      expect(rows('motion_events')).toEqual([
        expect.objectContaining({ camera_id: null, video_path: '/motion/clip.mp4' }),
      ]);
    });

    it('leaves other cameras’ media attributed', () => {
      insertCamera('cam-other', 'Garden', 'motion');
      adapter.createCamera(newCamera('cam-1', 'Front Door'));
      insertMotionEvent('cam-1');
      insertMotionEvent('cam-other');

      adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 });

      expect(rows('motion_events').map((row) => row.camera_id)).toEqual([null, 'cam-other']);
    });

    it('keeps media attributed when only the source is retired', () => {
      insertCamera('cam-1', 'Hallway', 'motion');
      adapter.attach(attachment('cam-1'));
      insertMotionEvent('cam-1');

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({
        removed: 'source',
      });
      expect(rows('motion_events')[0]).toMatchObject({ camera_id: 'cam-1' });
    });
  });
});
