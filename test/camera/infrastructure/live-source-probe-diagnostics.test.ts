import { describe, expect, it } from 'vitest';
import { LiveSourceProbeBaseError } from '../../../src/camera/domain/errors/live-source-probe-base.error';
import { LiveSourceProbeTimeoutError } from '../../../src/camera/domain/errors/live-source-probe-timeout.error';
import {
  DIAGNOSTIC_MARKERS,
  asProbeError,
  classifyProbeDiagnostics,
  classifyResolverFailure,
} from '../../../src/camera/infrastructure/live-source-probe-diagnostics';

/**
 * One fixture per marker row, each written the way the tool actually prints it
 * at `-loglevel error`. The guard below enforces the "one fixture per row" rule
 * and, more importantly, that each fixture reaches its own row rather than
 * being absorbed by an earlier one — a shadowed row is a row nothing verifies.
 */
const MARKER_FIXTURES: readonly [string, string][] = [
  [
    '[rtsp @ 0x5581] Server returned 4XX Client Error (authorization failed)\n',
    'LIVE_SOURCE_AUTHENTICATION_REJECTED',
  ],
  [
    '[rtsp @ 0x5581] method DESCRIBE failed: 401 Unauthorized\n',
    'LIVE_SOURCE_AUTHENTICATION_REJECTED',
  ],
  [
    '[rtsp @ 0x5581] method DESCRIBE failed: 403 Forbidden\n',
    'LIVE_SOURCE_AUTHENTICATION_REJECTED',
  ],
  [
    '[tls @ 0x5581] error:0A000086:SSL routines::certificate verify failed\n',
    'LIVE_SOURCE_TLS_VERIFICATION_FAILED',
  ],
  [
    '[tls @ 0x5581] Certificate verification failed: The certificate is NOT trusted.\n',
    'LIVE_SOURCE_TLS_VERIFICATION_FAILED',
  ],
  [
    '[tls @ 0x5581] Verify error:unable to get local issuer certificate\n',
    'LIVE_SOURCE_TLS_VERIFICATION_FAILED',
  ],
  [
    '[tls @ 0x5581] Verify error:self-signed certificate in certificate chain\n',
    'LIVE_SOURCE_TLS_VERIFICATION_FAILED',
  ],
  [
    '[tls @ 0x5581] Verify error:self signed certificate in certificate chain\n',
    'LIVE_SOURCE_TLS_VERIFICATION_FAILED',
  ],
  [
    '[tcp @ 0x5581] Failed to resolve hostname cam.invalid: no such host\n',
    'LIVE_SOURCE_HOST_NOT_FOUND',
  ],
  [
    '[rtsp @ 0x5581] Unable to open resource: Name or service not known\n',
    'LIVE_SOURCE_HOST_NOT_FOUND',
  ],
  [
    '[udp @ 0x5581] No address associated with hostname\n',
    'LIVE_SOURCE_HOST_NOT_FOUND',
  ],
  [
    '[tcp @ 0x5581] Connection to tcp://cam.local:554 failed: Connection refused\n',
    'LIVE_SOURCE_HOST_UNREACHABLE',
  ],
  [
    '[tcp @ 0x5581] Connection to tcp://cam.local:554 failed: No route to host\n',
    'LIVE_SOURCE_HOST_UNREACHABLE',
  ],
  [
    '[tcp @ 0x5581] Connection to tcp://cam.local:554 failed: Network is unreachable\n',
    'LIVE_SOURCE_HOST_UNREACHABLE',
  ],
  [
    '[udp @ 0x5581] Failed to send packet: Host is unreachable\n',
    'LIVE_SOURCE_HOST_UNREACHABLE',
  ],
  [
    '[tcp @ 0x5581] Connection to tcp://cam.local:554 failed: Connection timed out\n',
    'LIVE_SOURCE_HOST_UNREACHABLE',
  ],
  [
    '[rtsp @ 0x5581] Could not find codec parameters for stream 0 (Video: h264, none)\n',
    'LIVE_SOURCE_UNSUPPORTED_STREAM',
  ],
  [
    "Stream map '0:v:0' matches no streams.\n",
    'LIVE_SOURCE_UNSUPPORTED_STREAM',
  ],
  [
    '[rtsp @ 0x5581] Invalid data found when processing input\n',
    'LIVE_SOURCE_UNSUPPORTED_STREAM',
  ],
  [
    '[rtsp @ 0x5581] Unsupported codec with id 0 for input stream 0\n',
    'LIVE_SOURCE_UNSUPPORTED_STREAM',
  ],
  [
    'Output file #0 does not contain any stream\n',
    'LIVE_SOURCE_UNSUPPORTED_STREAM',
  ],
];

const CREDENTIALLED_URL = 'rtsp://user:pass@cam.local/private?token=secret';

/** No URL, host, credential, raw output, or cause may survive on a probe error. */
function expectNoDiagnostics(failure: unknown): void {
  const error = failure as Error & { cause?: unknown };
  expect(error).toBeInstanceOf(Error);
  expect('cause' in error).toBe(false);
  expect(Object.getOwnPropertyNames(error)).not.toContain('cause');
  const serialized = [
    JSON.stringify(error),
    String(error),
    error.message,
    Object.values(error).join(' '),
  ].join(' ');
  expect(serialized).not.toMatch(
    /user|pass|private|token|secret|cam\.local|cam\.invalid|0x5581|401|403|DESCRIBE|stderr|ffmpeg|getaddrinfo/i,
  );
}

describe('classifyProbeDiagnostics', () => {
  it.each(MARKER_FIXTURES)('maps %j to its typed kind', (stderr, code) => {
    const failure = classifyProbeDiagnostics(stderr);

    expect(failure).toMatchObject({ code });
    expectNoDiagnostics(failure);
  });

  it('gives every marker a fixture that no earlier marker shadows', () => {
    for (const [index, [marker]] of DIAGNOSTIC_MARKERS.entries()) {
      const matching = MARKER_FIXTURES.filter(([stderr]) =>
        stderr.toLowerCase().includes(marker),
      );
      expect(matching, `no fixture contains the marker "${marker}"`).not.toEqual([]);
      const earlier = DIAGNOSTIC_MARKERS.slice(0, index).map(([value]) => value);
      const reachesItsRow = matching.some(
        ([stderr]) =>
          !earlier.some((value) => stderr.toLowerCase().includes(value)),
      );
      expect(
        reachesItsRow,
        `every fixture for "${marker}" is shadowed by an earlier marker`,
      ).toBe(true);
    }
  });

  it('has exactly one fixture per marker row', () => {
    expect(MARKER_FIXTURES).toHaveLength(DIAGNOSTIC_MARKERS.length);
  });

  // Pins the documented order. A camera that rejects DESCRIBE also reports the
  // connection that carried it; reordering the table would turn a wrong
  // password into network advice with nothing else failing.
  it('prefers authentication over transport when the child reports both', () => {
    const stderr = [
      '[tcp @ 0x5581] Connection to tcp://cam.local:554 failed: Connection refused',
      '[rtsp @ 0x5581] method DESCRIBE failed: 401 Unauthorized',
      '',
    ].join('\n');

    expect(classifyProbeDiagnostics(stderr)).toMatchObject({
      code: 'LIVE_SOURCE_AUTHENTICATION_REJECTED',
    });
  });

  it.each([
    ['ffmpeg failed in a way nobody wrote a marker for\n'],
    [''],
    // A resolver that failed is not a hostname that is wrong: this stays
    // generic together with its EAI_AGAIN twin.
    ['[tcp @ 0x5581] Temporary failure in name resolution\n'],
  ])('leaves unclassifiable text %j generic', (stderr) => {
    expect(classifyProbeDiagnostics(stderr)).toMatchObject({
      code: 'LIVE_SOURCE_PROBE_FAILED',
    });
  });

  it('reads Buffer output exactly like string output', () => {
    expect(
      classifyProbeDiagnostics(
        Buffer.from('[rtsp @ 0x5581] method DESCRIBE failed: 401 Unauthorized\n'),
      ),
    ).toMatchObject({ code: 'LIVE_SOURCE_AUTHENTICATION_REJECTED' });
  });

  it('ignores a marker beyond the 64 KiB diagnostic cap', () => {
    expect(
      classifyProbeDiagnostics(
        `${'x'.repeat(65_536)}\n[rtsp @ 0x5581] method DESCRIBE failed: 401 Unauthorized\n`,
      ),
    ).toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
  });

  // It runs inside the execFile callback, so a throw here would be an uncaught
  // exception and a PM2 restart rather than a failed probe.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object whose toString throws', { toString() { throw new Error('nope'); } }],
  ])('stays total for %s output', (_label, value) => {
    expect(
      classifyProbeDiagnostics(value as unknown as string),
    ).toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
  });
});

describe('classifyResolverFailure', () => {
  it.each([
    ['ENOTFOUND', 'LIVE_SOURCE_HOST_NOT_FOUND'],
    ['ENODATA', 'LIVE_SOURCE_HOST_NOT_FOUND'],
    // The resolver failed, not the name. Saying "host not found" would send an
    // administrator whose DNS server is down to re-check a correct hostname.
    ['EAI_AGAIN', 'LIVE_SOURCE_PROBE_FAILED'],
    ['EAI_NONAME', 'LIVE_SOURCE_PROBE_FAILED'],
    ['EPERM', 'LIVE_SOURCE_PROBE_FAILED'],
  ])('maps resolver code %s to %s', (code, expected) => {
    const failure = classifyResolverFailure(
      Object.assign(new Error(`getaddrinfo ${code} cam.local`), {
        code,
        hostname: 'cam.local',
        syscall: 'getaddrinfo',
      }),
    );

    expect(failure).toMatchObject({ code: expected });
    expectNoDiagnostics(failure);
  });

  it.each([
    ['a bare Error', new Error(CREDENTIALLED_URL)],
    ['a numeric code', Object.assign(new Error('boom'), { code: 7 })],
    ['a string throwable', CREDENTIALLED_URL],
    ['null', null],
  ])('classifies %s as generic', (_label, thrown) => {
    const failure = classifyResolverFailure(thrown);

    expect(failure).toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
    expectNoDiagnostics(failure);
  });
});

describe('asProbeError', () => {
  it('returns a probe failure unchanged', () => {
    const timeout = new LiveSourceProbeTimeoutError();

    expect(asProbeError(timeout)).toBe(timeout);
  });

  // The point of the shared base: a kind added later is recognized without
  // anyone remembering to extend a list here.
  it('recognizes a probe error it has never heard of', () => {
    class FutureProbeError extends LiveSourceProbeBaseError {
      readonly code = 'LIVE_SOURCE_FUTURE' as const;

      constructor() {
        super('a kind added after this recognizer was written');
        this.name = 'FutureProbeError';
      }
    }
    const future = new FutureProbeError();

    expect(asProbeError(future)).toBe(future);
  });

  it.each([
    ['a plain Error carrying the URL', new Error(CREDENTIALLED_URL)],
    ['a string throwable', CREDENTIALLED_URL],
    ['undefined', undefined],
    ['an error with a cause', Object.assign(new Error('boom'), { cause: CREDENTIALLED_URL })],
  ])('reduces %s to the generic failure', (_label, thrown) => {
    const failure = asProbeError(thrown);

    expect(failure).toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
    expectNoDiagnostics(failure);
  });
});
