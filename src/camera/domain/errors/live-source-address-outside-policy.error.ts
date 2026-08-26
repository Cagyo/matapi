import { LiveSourceProbeBaseError } from './live-source-probe-base.error';

/**
 * The host resolved to a well-formed address that no configured RTSP CIDR
 * contains. Reached only after the address parsed successfully, so it never
 * overlaps a malformed-address failure, and it also covers a camera resolving
 * to IPv6 under an IPv4-only policy — containment fails on family mismatch.
 *
 * Parameterless like every probe error: the address derives from the
 * credentialed URL's hostname and must not travel with the failure.
 */
export class LiveSourceAddressOutsidePolicyError extends LiveSourceProbeBaseError {
  readonly code = 'LIVE_SOURCE_ADDRESS_OUTSIDE_POLICY' as const;

  constructor() {
    super('Live source address is outside the permitted camera networks');
    this.name = 'LiveSourceAddressOutsidePolicyError';
  }
}
