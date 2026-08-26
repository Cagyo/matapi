import type { LiveSourceAuthenticationRejectedError } from '../errors/live-source-authentication-rejected.error';
import type { LiveSourceHostNotFoundError } from '../errors/live-source-host-not-found.error';
import type { LiveSourceHostUnreachableError } from '../errors/live-source-host-unreachable.error';
import type { LiveSourceProbeFailedError } from '../errors/live-source-probe-failed.error';
import type { LiveSourceProbeTimeoutError } from '../errors/live-source-probe-timeout.error';
import type { LiveSourceTlsVerificationError } from '../errors/live-source-tls-verification.error';
import type { LiveSourceUnsupportedStreamError } from '../errors/live-source-unsupported-stream.error';
import type { LiveSource } from '../live-source.entity';

export const LIVE_SOURCE_PROBE = Symbol('LIVE_SOURCE_PROBE');

/**
 * Every failure `run` rejects with. Each member is parameterless on purpose:
 * the probed URL carries the camera credentials, so nothing about the URL, the
 * host, or the underlying process output may travel with the error.
 */
export type LiveSourceProbeError =
  | LiveSourceHostNotFoundError
  | LiveSourceHostUnreachableError
  | LiveSourceAuthenticationRejectedError
  | LiveSourceTlsVerificationError
  | LiveSourceUnsupportedStreamError
  | LiveSourceProbeTimeoutError
  | LiveSourceProbeFailedError;

export interface LiveSourceProbePort {
  run(source: LiveSource): Promise<void>;
}
