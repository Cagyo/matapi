import { LiveSourceAuthenticationRejectedError } from '../domain/errors/live-source-authentication-rejected.error';
import { LiveSourceHostNotFoundError } from '../domain/errors/live-source-host-not-found.error';
import { LiveSourceHostUnreachableError } from '../domain/errors/live-source-host-unreachable.error';
import { LiveSourceProbeBaseError } from '../domain/errors/live-source-probe-base.error';
import { LiveSourceProbeFailedError } from '../domain/errors/live-source-probe-failed.error';
import { LiveSourceTlsVerificationError } from '../domain/errors/live-source-tls-verification.error';
import { LiveSourceUnsupportedStreamError } from '../domain/errors/live-source-unsupported-stream.error';
import type { LiveSourceProbeError } from '../domain/ports/live-source-probe.port';

/**
 * Pure, stateless classification of live-source probe failures.
 *
 * It is deliberately separate from the probe adapter, whose difficulty is
 * deadlines, leases, sinks, and process lifetimes: nothing here touches any of
 * that, and nothing here holds state between calls. Every function takes
 * credential-bearing input and returns a parameterless typed error, discarding
 * the input.
 */

/** Diagnostics past this many characters are not examined; see `classifyProbeDiagnostics`. */
const MAX_DIAGNOSTIC_CHARACTERS = 65_536;
/**
 * Fixed markers, matched in order, first hit wins. Every entry is an ASCII
 * substring FFmpeg/OpenSSL/GnuTLS print verbatim under `LANG=C`; nothing here
 * is a pattern over attacker- or camera-controlled text, and the matched text
 * itself is discarded — only the resulting kind survives.
 *
 * Order is load-bearing and pinned by test: authentication is checked before
 * transport because a rejected DESCRIBE also reports the connection it was
 * carried over, and classifying that as a transport problem would send an
 * administrator to the network when the password is what is wrong.
 *
 * Validated against the FFmpeg builds Debian ships for this deployment —
 * 5.1 (bookworm) through 7.1 (trixie) at `-loglevel error` — with OpenSSL
 * 1.1.1/3.x and GnuTLS 3.7 certificate wording. These messages are not a
 * stability contract: a reworded upstream message silently downgrades its kind
 * to the generic failure, so re-check the table when the FFmpeg major changes.
 * Each row has its own fixture in `live-source-probe-diagnostics.test.ts`; a
 * row without one is a row nothing verifies.
 */
export const DIAGNOSTIC_MARKERS: readonly (readonly [
  string,
  () => LiveSourceProbeError,
])[] = [
  ['authorization failed', () => new LiveSourceAuthenticationRejectedError()],
  ['401 unauthorized', () => new LiveSourceAuthenticationRejectedError()],
  ['403 forbidden', () => new LiveSourceAuthenticationRejectedError()],
  ['certificate verify failed', () => new LiveSourceTlsVerificationError()],
  ['certificate verification failed', () => new LiveSourceTlsVerificationError()],
  ['unable to get local issuer certificate', () => new LiveSourceTlsVerificationError()],
  ['self-signed certificate', () => new LiveSourceTlsVerificationError()],
  ['self signed certificate', () => new LiveSourceTlsVerificationError()],
  ['failed to resolve hostname', () => new LiveSourceHostNotFoundError()],
  ['name or service not known', () => new LiveSourceHostNotFoundError()],
  ['no address associated with hostname', () => new LiveSourceHostNotFoundError()],
  ['connection refused', () => new LiveSourceHostUnreachableError()],
  ['no route to host', () => new LiveSourceHostUnreachableError()],
  ['network is unreachable', () => new LiveSourceHostUnreachableError()],
  ['host is unreachable', () => new LiveSourceHostUnreachableError()],
  // A connect that timed out is a fact about the host, not about our budget:
  // the peer never answered. Our own monotonic deadline expiring is the
  // separate `LiveSourceProbeTimeoutError` raised in the probe adapter, which
  // means "we gave up", not "the camera is silent". Keep the two apart.
  ['connection timed out', () => new LiveSourceHostUnreachableError()],
  ['could not find codec parameters', () => new LiveSourceUnsupportedStreamError()],
  ['matches no streams', () => new LiveSourceUnsupportedStreamError()],
  ['invalid data found when processing input', () => new LiveSourceUnsupportedStreamError()],
  ['unsupported codec', () => new LiveSourceUnsupportedStreamError()],
  ['does not contain any stream', () => new LiveSourceUnsupportedStreamError()],
];

/**
 * Turns child diagnostics into one typed kind and throws the text away. The
 * input holds the probed URL — password included — so it is never logged,
 * attached as `cause`, or copied onto the returned error.
 *
 * Only the first `MAX_DIAGNOSTIC_CHARACTERS` are considered. The spawn seam already
 * caps the child's stderr at the same size; the markers are ASCII, so the
 * character bound and the byte bound coincide for anything matchable.
 */
export function classifyProbeDiagnostics(
  diagnostics: string | Buffer,
): LiveSourceProbeError {
  // Total by construction. This runs inside the `execFile` callback rather than
  // a promise executor, so a throw here would surface as an uncaught exception
  // and cost the worker a PM2 restart. Anything that is neither string nor
  // Buffer classifies as unknown instead — including a value whose own
  // `toString` would throw, which is never invoked.
  const raw =
    typeof diagnostics === 'string'
      ? diagnostics
      : Buffer.isBuffer(diagnostics)
        ? diagnostics.toString('utf8')
        : '';
  const text = raw.slice(0, MAX_DIAGNOSTIC_CHARACTERS).toLowerCase();
  for (const [marker, create] of DIAGNOSTIC_MARKERS) {
    if (text.includes(marker)) return create();
  }
  return new LiveSourceProbeFailedError();
}

/**
 * Keeps an already-classified probe failure and reduces everything else to the
 * generic one. Unknown throwables never pass through: their message or `cause`
 * could carry the credentialed URL.
 */
export function asProbeError(error: unknown): LiveSourceProbeBaseError {
  if (error instanceof LiveSourceProbeBaseError) return error;
  return new LiveSourceProbeFailedError();
}

/**
 * The codes that mean the name itself did not resolve, and only those that
 * `dns.promises.lookup` actually emits. The probe's `lookup` is injectable, so
 * this deliberately stays a small allowlist rather than a guess at every
 * resolver's vocabulary — an unlisted code classifies as unknown.
 *
 * `EAI_AGAIN` is excluded on purpose: it means the resolver failed — DNS server
 * unreachable, SERVFAIL, no network — not that the hostname is wrong. Reporting
 * it as an unresolved host would send an administrator whose router just
 * rebooted to re-check a perfectly correct name. It stays generic, together
 * with its stderr twin `temporary failure in name resolution`.
 */
const UNRESOLVED_HOST_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'ENODATA',
]);

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === 'string' ? code : null;
}

/**
 * Classifies a rejected hostname lookup by its code alone. The rejected error
 * carries the hostname and is dropped here rather than re-thrown, so nothing
 * derived from the credentialed URL travels further.
 */
export function classifyResolverFailure(error: unknown): LiveSourceProbeError {
  const code = errorCode(error);
  if (code !== null && UNRESOLVED_HOST_CODES.has(code)) {
    return new LiveSourceHostNotFoundError();
  }
  return new LiveSourceProbeFailedError();
}
