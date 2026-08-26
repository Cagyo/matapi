import { LiveSourceProbeBaseError } from './live-source-probe-base.error';

/** Strict TLS was requested and the live source certificate did not verify. */
export class LiveSourceTlsVerificationError extends LiveSourceProbeBaseError {
  readonly code = 'LIVE_SOURCE_TLS_VERIFICATION_FAILED' as const;

  constructor() {
    super('Live source TLS certificate could not be verified');
    this.name = 'LiveSourceTlsVerificationError';
  }
}
