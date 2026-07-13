import { describe, expect, it } from 'vitest';
import { InvalidLiveSourceError } from '../../../src/camera/domain/errors/invalid-live-source.error';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';

describe('LiveSource', () => {
  it('defaults to bounded eco video settings over TCP', () => {
    const source = LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://cam.local/live',
    });

    expect(source.settings).toEqual({
      scheme: 'rtsp',
      tlsMode: 'none',
      transport: 'tcp',
      profile: 'eco',
      videoOnly: true,
      maxConverters: 1,
      maxViewers: 2,
      startTimeoutMs: 30_000,
      stopTimeoutMs: 5_000,
      substream: null,
    });
    expect({
      transport: source.transport,
      tlsMode: source.tlsMode,
      profile: source.profile,
      substream: source.substream,
    }).toEqual({
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      substream: null,
    });
    expect(source.ready).toBe(false);
  });

  it('uses strict CA and hostname verification for RTSPS', () => {
    const source = LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsps://cam.local/live',
      ready: true,
    });

    expect(source.settings).toMatchObject({
      scheme: 'rtsps',
      tlsMode: 'strict',
    });
  });

  it('rejects unsupported self-signed RTSPS without advertising the mode', () => {
    expect(() =>
      LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsps://cam.local/live',
        tlsMode: 'self-signed' as never,
      }),
    ).toThrow(InvalidLiveSourceError);
  });

  it('does not reveal userinfo, path, query, fragment, or ciphertext in a summary', () => {
    const source = LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://user:pass@CAM.local:554/private/live?token=secret#frame',
      ready: true,
    });

    expect(source.summary()).toEqual({
      scheme: 'rtsp',
      host: 'cam.local:554',
      transport: 'tcp',
      ready: true,
    });
    expect(JSON.stringify(source)).not.toMatch(
      /user|pass|private|token|secret|frame|ciphertext/i,
    );
  });

  it.each(['http://cam.local/live', 'file:///tmp/video']) (
    'rejects the unsupported scheme in %s',
    (url) => {
      expect(() =>
        LiveSource.create({ cameraId: 'front_door', url }),
      ).toThrow(InvalidLiveSourceError);
    },
  );

  it('rejects raw URL control characters before parsing', () => {
    expect(() =>
      LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsp://cam.local/live\nignored',
      }),
    ).toThrow(InvalidLiveSourceError);
  });

  it('supports explicit transport, profile, substream, and readiness settings', () => {
    const source = LiveSource.create({
      cameraId: 'garden',
      url: 'rtsp://cam.local/main',
      transport: 'udp',
      profile: 'quality',
      substream: 'low-bandwidth',
      ready: true,
    });

    expect(source.settings).toMatchObject({
      transport: 'udp',
      profile: 'quality',
      substream: 'low-bandwidth',
    });
    expect(source.ready).toBe(true);
  });
});
