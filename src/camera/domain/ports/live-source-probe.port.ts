import type { LiveSourceAddressOutsidePolicyError } from '../errors/live-source-address-outside-policy.error';
import type { LiveSourceAuthenticationRejectedError } from '../errors/live-source-authentication-rejected.error';
import type { LiveSourceHostNotFoundError } from '../errors/live-source-host-not-found.error';
import type { LiveSourceHostUnreachableError } from '../errors/live-source-host-unreachable.error';
import { LiveSourceProbeBaseError } from '../errors/live-source-probe-base.error';
import type { LiveSourceProbeFailedError } from '../errors/live-source-probe-failed.error';
import type { LiveSourceProbeTimeoutError } from '../errors/live-source-probe-timeout.error';
import type { LiveSourceTlsVerificationError } from '../errors/live-source-tls-verification.error';
import type { LiveSourceUnsupportedStreamError } from '../errors/live-source-unsupported-stream.error';
import type { LiveSource } from '../live-source.entity';

export const LIVE_SOURCE_PROBE = Symbol('LIVE_SOURCE_PROBE');

/**
 * Every failure `run` rejects with, for exhaustive rendering at the interface
 * boundary. Each member is parameterless on purpose: the probed URL carries the
 * camera credentials, so nothing about the URL, the host, or the underlying
 * process output may travel with the error.
 */
export type LiveSourceProbeError =
  | LiveSourceHostNotFoundError
  | LiveSourceHostUnreachableError
  | LiveSourceAddressOutsidePolicyError
  | LiveSourceAuthenticationRejectedError
  | LiveSourceTlsVerificationError
  | LiveSourceUnsupportedStreamError
  | LiveSourceProbeTimeoutError
  | LiveSourceProbeFailedError;

/**
 * Compile-time proof that every member of the union is recognizable by the one
 * `instanceof` check probing performs. Without this, adding a member that does
 * not extend the shared base would silently downgrade it to the generic
 * failure at every catch site, with no test able to notice.
 */
type ProbeErrorsShareTheBase =
  LiveSourceProbeError extends LiveSourceProbeBaseError ? true : never;
const _probeErrorsShareTheBase: ProbeErrorsShareTheBase = true;
void _probeErrorsShareTheBase;

export interface LiveSourceProbePort {
  run(source: LiveSource): Promise<void>;
}
