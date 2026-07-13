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

  it('keeps complete primary and substream URLs only in one encryption payload', () => {
    const source = LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://user:pass@CAM.local:554/private/main?token=secret#main',
      substream:
        'rtsp://sub-user:sub-pass@CAM.local:8554/private/sub?key=hidden#sub',
    });

    expect(source.settings.substream).toBe('rtsp://cam.local:8554');
    expect(source.credentialPayload()).toEqual({
      primaryUrl:
        'rtsp://user:pass@cam.local:554/private/main?token=secret#main',
      substreamUrl:
        'rtsp://sub-user:sub-pass@cam.local:8554/private/sub?key=hidden#sub',
    });
    expect(JSON.stringify(source)).not.toMatch(
      /user|pass|private|token|secret|hidden|#main|#sub/i,
    );
  });

  it.each([
    [
      'rtsp://usér:p@BÜCHER.example/private path?q=hello world#frägment',
      'rtsp://us%C3%A9r:p@xn--bcher-kva.example/private%20path?q=hello%20world#fr%C3%A4gment',
      'rtsp://xn--bcher-kva.example',
    ],
    [
      'rtsp://user:pass@cam%2elocal:8554/a%2fb?q=%2f#x',
      'rtsp://user:pass@cam.local:8554/a%2fb?q=%2f#x',
      'rtsp://cam.local:8554',
    ],
    ['rtsp://0177.1/live', 'rtsp://127.0.0.1/live', 'rtsp://127.0.0.1'],
    [
      'rtsp://[2001:0DB8::1]:8554/live?q=x#f',
      'rtsp://[2001:db8::1]:8554/live?q=x#f',
      'rtsp://[2001:db8::1]:8554',
    ],
    ['rtsp://CAM.LOCAL./live', 'rtsp://cam.local/live', 'rtsp://cam.local'],
    ['rtsp://CAM.LOCAL.../live', 'rtsp://cam.local/live', 'rtsp://cam.local'],
    ['rtsp://CAM.LOCAL/live?', 'rtsp://cam.local/live?', 'rtsp://cam.local'],
    ['rtsp://CAM.LOCAL/live#', 'rtsp://cam.local/live#', 'rtsp://cam.local'],
    ['rtsp://CAM.LOCAL/live?#', 'rtsp://cam.local/live?#', 'rtsp://cam.local'],
  ])(
    'uses one canonical authority for metadata and primary/substream secret %s',
    (url, credentialUrl, normalizedUrl) => {
      const source = LiveSource.create({
        cameraId: 'front_door',
        url,
        substream: url,
      });
      const payload = source.credentialPayload();

      expect(source.normalizedUrl).toBe(normalizedUrl);
      expect(source.settings.substream).toBe(normalizedUrl);
      expect(payload).toEqual({
        primaryUrl: credentialUrl,
        substreamUrl: credentialUrl,
      });
      expect(`rtsp://${new URL(payload.primaryUrl).host}`).toBe(normalizedUrl);
      expect(`rtsp://${new URL(payload.substreamUrl!).host}`).toBe(normalizedUrl);
    },
  );

  it('does not include credential text in validation failures', () => {
    try {
      LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsp://private-user:private-pass@bad_host/private?token=secret',
      });
      expect.unreachable('expected invalid source');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLiveSourceError);
      expect((error as Error).message).not.toMatch(
        /private-user|private-pass|private|token|secret/,
      );
    }
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

  it.each([
    'http://user:pass@cam.local/private/sub?token=secret',
    'file:///private/substream',
  ])('rejects an unsupported substream scheme in %s', (substream) => {
    expect(() =>
      LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsp://cam.local/main',
        substream,
      }),
    ).toThrow(InvalidLiveSourceError);
  });

  it('rejects a substream whose TLS scheme differs from the primary source', () => {
    expect(() =>
      LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsps://cam.local/main',
        substream: 'rtsp://cam.local/sub',
      }),
    ).toThrow(InvalidLiveSourceError);
  });

  it.each([
    {
      url: 'rtsp://cam.local\\@evil.example:8554/live',
    },
    {
      url: 'rtsp://cam.local/main',
      substream: 'rtsp://cam.local\\@evil.example:8554/sub',
    },
  ])('rejects ambiguous primary or substream authority parsing: %s', (input) => {
    expect(() =>
      LiveSource.create({ cameraId: 'front_door', ...input }),
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
      tlsMode: 'none',
      profile: 'eco',
      substreamHost: null,
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
      substream: 'rtsp://cam.local:8554/low-bandwidth',
      ready: true,
    });

    expect(source.settings).toMatchObject({
      transport: 'udp',
      profile: 'quality',
      substream: 'rtsp://cam.local:8554',
    });
    expect(source.ready).toBe(true);
  });

  it.each([
    [null as never, 'whole input'],
    [{ cameraId: null as never }, 'cameraId'],
    [{ cameraId: 42 as never }, 'cameraId'],
    [{ url: null as never }, 'url'],
    [{ url: {} as never }, 'url'],
    [{ transport: 'sctp' as never }, 'transport'],
    [{ tlsMode: 1 as never }, 'tlsMode'],
    [{ profile: 'huge' as never }, 'profile'],
    [{ substream: 123 as never }, 'substream'],
    [{ ready: 'yes' as never }, 'ready'],
  ])('maps malformed runtime %s to InvalidLiveSourceError (%s)', (override) => {
    expect(() =>
      LiveSource.create(
        override === null
          ? override
          : {
              cameraId: 'front_door',
              url: 'rtsp://cam.local/main',
              ...override,
            },
      ),
    ).toThrow(InvalidLiveSourceError);
  });

  it('rejects an empty substream endpoint instead of treating it as absent', () => {
    expect(() =>
      LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsp://cam.local/main',
        substream: '',
      }),
    ).toThrow(InvalidLiveSourceError);
  });

  it.each([
    ['rtsp://BÜCHER.example/live', 'rtsp://xn--bcher-kva.example'],
    ['rtsp://CAM.LOCAL./live', 'rtsp://cam.local'],
    ['rtsp://[2001:DB8::1]:8554/live', 'rtsp://[2001:db8::1]:8554'],
    ['rtsp://cam.local/live', 'rtsp://cam.local'],
    ['rtsp://cam.local:554/live', 'rtsp://cam.local:554'],
  ])('canonicalizes endpoint %s as %s', (url, normalizedUrl) => {
    const source = LiveSource.create({ cameraId: 'front_door', url });

    expect(source.normalizedUrl).toBe(normalizedUrl);
    expect(source.summary().host).toBe(new URL(normalizedUrl).host);
  });

  it.each([
    'rtsp://cam.local:0/live',
    'rtsp://./live',
    'rtsp://-invalid.local/live',
  ])('rejects the unusable endpoint %s', (url) => {
    expect(() => LiveSource.create({ cameraId: 'front_door', url })).toThrow(
      InvalidLiveSourceError,
    );
  });
});
