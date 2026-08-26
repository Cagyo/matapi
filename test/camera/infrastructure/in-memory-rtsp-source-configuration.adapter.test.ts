import { beforeEach, describe, expect, it } from 'vitest';
import { cameraNameKey } from '../../../src/camera/domain/camera-name-key';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { EncryptedLiveSourceCredential } from '../../../src/camera/domain/ports/live-source-credential.port';
import { InMemoryRtspSourceConfigurationAdapter } from '../../../src/camera/infrastructure/in-memory-rtsp-source-configuration.adapter';

const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1?token=abcdef';
const REPLACEMENT_URL = 'rtsp://operator:hunter2@other.local/stream2';

function credential(keyVersion = 1): EncryptedLiveSourceCredential {
  return { ciphertext: 'ct', nonce: 'nc', authTag: 'at', keyVersion };
}

function source(cameraId: string, url = SECRET_URL): LiveSource {
  return LiveSource.create({ cameraId, url, transport: 'tcp', profile: 'eco', ready: true });
}

describe('InMemoryRtspSourceConfigurationAdapter', () => {
  let adapter: InMemoryRtspSourceConfigurationAdapter;
  const verifiedAt = new Date('2026-08-20T10:30:00.500Z');

  beforeEach(() => {
    adapter = new InMemoryRtspSourceConfigurationAdapter();
  });

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

  it('creates camera, source and credential together and returns a redacted view', () => {
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
    expect(adapter.cameras()).toEqual([
      { id: 'cam-1', name: ' Front Door ', nameKey: 'front door', type: 'rtsp' },
    ]);
    expect(adapter.sources()).toHaveLength(1);
  });

  it('returns synchronously rather than through a promise', () => {
    expect(adapter.createCamera(newCamera('cam-1', 'Front Door'))).not.toBeInstanceOf(Promise);
  });

  it('rejects a name key that is not the canonical form of the name', () => {
    const input = newCamera('cam-1', 'Front Door');

    expect(() =>
      adapter.createCamera({ ...input, camera: { ...input.camera, nameKey: 'Front Door' } }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }));
    expect(adapter.cameras()).toEqual([]);
  });

  it('rejects a source addressed to a different camera than the one being created', () => {
    const input = newCamera('cam-1', 'Front Door');

    expect(() => adapter.createCamera({ ...input, source: source('cam-2') })).toThrow(
      expect.objectContaining({ code: 'INVALID_LIVE_SOURCE' }),
    );
    expect(adapter.cameras()).toEqual([]);
  });

  it('maps a camera identifier collision to a typed error and writes nothing', () => {
    adapter.seedCamera({ id: 'cam-1', name: 'Garden', type: 'motion' });

    expect(() => adapter.createCamera(newCamera('cam-1', 'Front Door'))).toThrow(
      expect.objectContaining({ code: 'CAMERA_ID_COLLISION' }),
    );
    expect(adapter.cameras()).toEqual([
      { id: 'cam-1', name: 'Garden', nameKey: 'garden', type: 'motion' },
    ]);
    expect(adapter.sources()).toEqual([]);
  });

  it('maps a canonical name collision to a name-taken error that names no camera', () => {
    adapter.seedCamera({ id: 'cam-0', name: 'front door', type: 'motion' });

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
    expect(adapter.cameras()).toHaveLength(1);
    expect(adapter.sources()).toEqual([]);
  });

  it('adds a verified source to an existing camera at revision zero', () => {
    adapter.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' });

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
  });

  it('rejects a second attach to the same camera as a state change', () => {
    adapter.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' });
    adapter.attach(attachment('cam-1'));

    expect(() => adapter.attach(attachment('cam-1'))).toThrow(
      expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
    );
    expect(adapter.sources()).toHaveLength(1);
  });

  it('rejects an attach whose camera disappeared', () => {
    expect(() => adapter.attach(attachment('cam-gone'))).toThrow(
      expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
    );
  });

  it('swaps the source at the expected revision and advances it by one', () => {
    adapter.createCamera(newCamera('cam-1', 'Front Door'));

    const result = adapter.replace({
      source: source('cam-1', REPLACEMENT_URL),
      credential: credential(2),
      policyDigest: 'digest-2',
      verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
      cameraId: 'cam-1',
      expectedRevision: 0,
    });

    expect(result).toMatchObject({
      revision: 1,
      policyDigest: 'digest-2',
      verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
      summary: expect.objectContaining({ host: 'other.local' }),
    });
    expect(JSON.stringify(result)).not.toMatch(/operator|hunter2/u);
  });

  it('rejects a stale replacement revision and leaves the stored source untouched', () => {
    adapter.createCamera(newCamera('cam-1', 'Front Door'));
    const input = {
      source: source('cam-1', REPLACEMENT_URL),
      credential: credential(2),
      policyDigest: 'digest-2',
      verifiedAt: new Date('2026-08-21T09:00:00.250Z'),
      cameraId: 'cam-1',
      expectedRevision: 0,
    };
    adapter.replace(input);

    expect(() => adapter.replace(input)).toThrow(
      expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
    );
    expect(adapter.sources()[0]).toMatchObject({ revision: 1, policyDigest: 'digest-2' });
  });

  it('deletes the whole camera when the stored type is rtsp', () => {
    adapter.createCamera(newCamera('cam-1', 'Front Door'));

    expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({ removed: 'camera' });
    expect(adapter.cameras()).toEqual([]);
    expect(adapter.sources()).toEqual([]);
  });

  it('preserves a non-rtsp camera and removes only its source', () => {
    adapter.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' });
    adapter.attach(attachment('cam-1'));

    expect(adapter.remove({ cameraId: 'cam-1', expectedRevision: 0 })).toEqual({ removed: 'source' });
    expect(adapter.cameras()).toHaveLength(1);
    expect(adapter.sources()).toEqual([]);
  });

  it('ignores a caller-supplied delete decision and trusts the stored type', () => {
    adapter.seedCamera({ id: 'cam-1', name: 'Hallway', type: 'motion' });
    adapter.attach(attachment('cam-1'));

    const forced = { cameraId: 'cam-1', expectedRevision: 0, removed: 'camera' as const };
    expect(adapter.remove(forced)).toEqual({ removed: 'source' });
    expect(adapter.cameras()).toHaveLength(1);
  });

  it('rejects a stale removal revision and deletes nothing', () => {
    adapter.createCamera(newCamera('cam-1', 'Front Door'));

    expect(() => adapter.remove({ cameraId: 'cam-1', expectedRevision: 3 })).toThrow(
      expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
    );
    expect(adapter.cameras()).toHaveLength(1);
    expect(adapter.sources()).toHaveLength(1);
  });

  it('rejects removal for a camera that is already gone', () => {
    expect(() => adapter.remove({ cameraId: 'cam-gone', expectedRevision: 0 })).toThrow(
      expect.objectContaining({ code: 'LIVE_SOURCE_STATE_CHANGED' }),
    );
  });
});
