import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { cameraNameKey } from '../../../src/camera/domain/camera-name-key';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { EncryptedLiveSourceCredential } from '../../../src/camera/domain/ports/live-source-credential.port';
import {
  RTSP_SOURCE_CAMERA_TYPE,
  type RtspSourceConfigurationPort,
} from '../../../src/camera/domain/ports/rtsp-source-configuration.port';
import { DrizzleRtspSourceConfigurationAdapter } from '../../../src/camera/infrastructure/drizzle-rtsp-source-configuration.adapter';
import { InMemoryRtspSourceConfigurationAdapter } from '../../../src/camera/infrastructure/in-memory-rtsp-source-configuration.adapter';

const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1?token=abcdef';
const REPLACEMENT_URL = 'rtsp://operator:hunter2@other.local/stream2';

function credential(keyVersion = 1): EncryptedLiveSourceCredential {
  return { ciphertext: 'ct', nonce: 'nc', authTag: 'at', keyVersion };
}

function source(cameraId: string, url = SECRET_URL): LiveSource {
  return LiveSource.create({ cameraId, url, transport: 'tcp', profile: 'eco', ready: true });
}

interface SeedCamera {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
}

/** One adapter under test, plus the minimum needed to seed and inspect it. */
interface Subject {
  adapter: RtspSourceConfigurationPort;
  seedCamera(camera: SeedCamera): void;
  cameraIds(): string[];
  cameraType(cameraId: string): string | undefined;
  sourceIds(): string[];
  revision(cameraId: string): number | null;
  dispose(): void;
}

function drizzleSubject(): Subject {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './migrations' });
  const rows = (sql: string): Record<string, unknown>[] =>
    sqlite.prepare(sql).all() as Record<string, unknown>[];

  return {
    adapter: new DrizzleRtspSourceConfigurationAdapter(db),
    seedCamera: (camera) =>
      void sqlite
        .prepare(
          'INSERT INTO cameras (id, name, name_key, type, config, enabled) VALUES (?, ?, ?, ?, NULL, ?)',
        )
        .run(
          camera.id,
          camera.name,
          cameraNameKey(camera.name),
          camera.type,
          camera.enabled === false ? 0 : 1,
        ),
    cameraIds: () => rows('SELECT id FROM cameras ORDER BY id').map((r) => String(r.id)),
    cameraType: (cameraId) =>
      rows('SELECT id, type FROM cameras').find((r) => r.id === cameraId)?.type as
        | string
        | undefined,
    sourceIds: () =>
      rows('SELECT camera_id FROM camera_live_sources ORDER BY camera_id').map((r) =>
        String(r.camera_id),
      ),
    revision: (cameraId) => {
      const row = rows('SELECT camera_id, revision FROM camera_live_sources').find(
        (r) => r.camera_id === cameraId,
      );
      return row === undefined ? null : Number(row.revision);
    },
    dispose: () => sqlite.close(),
  };
}

function inMemorySubject(): Subject {
  const adapter = new InMemoryRtspSourceConfigurationAdapter();
  return {
    adapter,
    seedCamera: (camera) => adapter.seedCamera(camera),
    cameraIds: () => adapter.cameras().map((camera) => camera.id).sort(),
    cameraType: (cameraId) =>
      adapter.cameras().find((camera) => camera.id === cameraId)?.type,
    sourceIds: () => adapter.sources().map((row) => row.cameraId).sort(),
    revision: (cameraId) =>
      adapter.sources().find((row) => row.cameraId === cameraId)?.revision ?? null,
    dispose: () => undefined,
  };
}

/**
 * One table of cases run against both adapters. The twins are only useful while
 * they answer identically, and Task 6's use-case tests run against the
 * in-memory one, so any rule asserted here has to hold in both.
 */
describe.each([
  ['DrizzleRtspSourceConfigurationAdapter', drizzleSubject],
  ['InMemoryRtspSourceConfigurationAdapter', inMemorySubject],
])('%s — source-configuration contract', (_name, makeSubject) => {
  let subject: Subject;
  let adapter: RtspSourceConfigurationPort;
  const verifiedAt = new Date('2026-08-20T10:30:00.500Z');

  beforeEach(() => {
    subject = makeSubject();
    adapter = subject.adapter;
  });

  afterEach(() => subject.dispose());

  function newCamera(id: string, name: string, url = SECRET_URL) {
    return {
      source: source(id, url),
      credential: credential(),
      policyDigest: 'digest-1',
      verifiedAt,
      camera: { id, name, nameKey: cameraNameKey(name) },
    };
  }

  function attachment(cameraId: string, url = SECRET_URL) {
    return {
      source: source(cameraId, url),
      credential: credential(),
      policyDigest: 'digest-1',
      verifiedAt,
      cameraId,
    };
  }

  function replacement(cameraId: string, expectedRevision: number) {
    return {
      source: source(cameraId, REPLACEMENT_URL),
      credential: credential(2),
      policyDigest: 'digest-2',
      verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
      cameraId,
      expectedRevision,
    };
  }

  describe('createCamera', () => {
    it('stores camera and source together and returns a redacted view', () => {
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
      expect(subject.cameraIds()).toEqual(['cam-1']);
      expect(subject.sourceIds()).toEqual(['cam-1']);
      expect(subject.cameraType('cam-1')).toBe(RTSP_SOURCE_CAMERA_TYPE);
    });

    it('returns synchronously rather than through a promise', () => {
      expect(adapter.createCamera(newCamera('cam-1', 'Front Door'))).not.toBeInstanceOf(
        Promise,
      );
    });

    it('rejects a name key that is not the canonical form of the name', () => {
      const input = newCamera('cam-1', 'Front Door');

      expect(() =>
        adapter.createCamera({ ...input, camera: { ...input.camera, nameKey: 'Front Door' } }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
      expect(subject.cameraIds()).toEqual([]);
    });

    it('rejects a source addressed to a different camera', () => {
      const input = newCamera('cam-1', 'Front Door');

      expect(() => adapter.createCamera({ ...input, source: source('cam-2') })).toThrow(
        expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }),
      );
      expect(subject.cameraIds()).toEqual([]);
    });

    it('maps a camera identifier collision to a typed error and writes nothing', () => {
      subject.seedCamera({ id: 'cam-1', name: 'Garden', type: 'motion' });

      expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
        expect.objectContaining({ code: 'CAMERA_ID_COLLISION' }),
      );
      expect(subject.cameraIds()).toEqual(['cam-1']);
      expect(subject.cameraType('cam-1')).toBe('motion');
      expect(subject.sourceIds()).toEqual([]);
    });

    it('maps a canonical name collision to an error that names no camera', () => {
      subject.seedCamera({ id: 'cam-0', name: 'front door', type: 'motion' });

      const failure = capture(() => adapter.createCamera(newCamera('cam-1', ' FRONT DOOR ')));

      expect(failure).toMatchObject({ code: 'CAMERA_NAME_TAKEN' });
      expect(failure?.message).not.toMatch(/front|door/iu);
      expect(subject.cameraIds()).toEqual(['cam-0']);
      expect(subject.sourceIds()).toEqual([]);
    });
  });

  describe('attach', () => {
    beforeEach(() => subject.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' }));

    it('adds a verified source to an existing camera at revision zero', () => {
      const result = adapter.attach(attachment('cam-1'));

      expect(result).toMatchObject({
        cameraId: 'cam-1',
        cameraName: 'Hallway',
        hasCredential: true,
        revision: 0,
        verifiedAt,
        policyDigest: 'digest-1',
      });
      expect(JSON.stringify(result)).not.toMatch(/operator|hunter2|abcdef/u);
      expect(subject.cameraType('cam-1')).toBe('motion');
    });

    it('rejects a second attach to the same camera as a state change', () => {
      adapter.attach(attachment('cam-1'));

      expect(() => adapter.attach(attachment('cam-1'))).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(subject.sourceIds()).toEqual(['cam-1']);
    });

    it('rejects an attach whose camera disappeared', () => {
      expect(() => adapter.attach(attachment('cam-gone'))).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
    });

    it('rejects an attach to a camera disabled since the caller looked', () => {
      subject.seedCamera({ id: 'cam-2', name: 'Garage', type: 'motion', enabled: false });

      expect(() => adapter.attach(attachment('cam-2'))).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(subject.sourceIds()).toEqual([]);
    });

    it('rejects a source addressed to a different camera', () => {
      expect(() =>
        adapter.attach({ ...attachment('cam-2'), cameraId: 'cam-1' }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
      expect(subject.sourceIds()).toEqual([]);
    });
  });

  describe('replace', () => {
    beforeEach(() => void adapter.createCamera(newCamera('cam-1', 'Front Door')));

    it('swaps the source at the expected revision and advances it by one', () => {
      const result = adapter.replace(replacement('cam-1', 0));

      expect(result).toMatchObject({
        cameraId: 'cam-1',
        cameraName: 'Front Door',
        revision: 1,
        policyDigest: 'digest-2',
        verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
        summary: expect.objectContaining({ host: 'other.local' }),
      });
      expect(JSON.stringify(result)).not.toMatch(/operator|hunter2/u);
      expect(subject.revision('cam-1')).toBe(1);
    });

    it('rejects a stale revision and leaves the stored source untouched', () => {
      adapter.replace(replacement('cam-1', 0));

      expect(() => adapter.replace(replacement('cam-1', 0))).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(subject.revision('cam-1')).toBe(1);
    });

    it('rejects a replacement for a camera with no stored source', () => {
      subject.seedCamera({ id: 'cam-2', name: 'Hallway', type: 'motion' });

      expect(() => adapter.replace(replacement('cam-2', 0))).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(subject.sourceIds()).toEqual(['cam-1']);
    });

    it('rejects a source addressed to a different camera', () => {
      expect(() =>
        adapter.replace({ ...replacement('cam-2', 0), cameraId: 'cam-1' }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
      expect(subject.revision('cam-1')).toBe(0);
    });
  });

  describe('remove', () => {
    it('deletes the whole camera when the stored type is the reserved one', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({
        removed: 'camera',
      });
      expect(subject.cameraIds()).toEqual([]);
      expect(subject.sourceIds()).toEqual([]);
    });

    it('preserves a camera that predates its source and removes only the source', () => {
      subject.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' });
      adapter.attach(attachment('cam-1'));

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({
        removed: 'source',
      });
      expect(subject.cameraIds()).toEqual(['cam-1']);
      expect(subject.sourceIds()).toEqual([]);
    });

    it('preserves a hand-written rtsp-backend camera, which is not the reserved type', () => {
      // `config/dev-state.yml` ships `type: rtsp`. That names a backend, not a
      // row this port owns, so removal must retire the source and stop there.
      subject.seedCamera({ id: 'cam-1', name: 'Front Door', type: 'rtsp' });
      adapter.attach(attachment('cam-1'));

      expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({
        removed: 'source',
      });
      expect(subject.cameraIds()).toEqual(['cam-1']);
    });

    it('ignores a caller-supplied delete decision and trusts the stored type', () => {
      subject.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' });
      adapter.attach(attachment('cam-1'));

      const forced = { cameraId: 'cam-1', expectedRevision: 0, removed: 'camera' as const };
      expect(adapter.remove(forced)).toEqual({ removed: 'source' });
      expect(subject.cameraIds()).toEqual(['cam-1']);
    });

    it('rejects a stale revision and deletes nothing', () => {
      adapter.createCamera(newCamera('cam-1', 'Front Door'));

      expect(() => adapter.remove({ cameraId: 'cam-1', expectedRevision: 3 })).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
      expect(subject.cameraIds()).toEqual(['cam-1']);
      expect(subject.sourceIds()).toEqual(['cam-1']);
    });

    it('rejects removal for a camera that is already gone', () => {
      expect(() => adapter.remove({ cameraId: 'cam-gone', expectedRevision: 0 })).toThrow(
        expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
      );
    });
  });
});

function capture(run: () => unknown): Error | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error;
  }
}
