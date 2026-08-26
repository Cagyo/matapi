import { LiveSourceProbeBaseError } from './live-source-probe-base.error';

/** The live source answered, then rejected the supplied credentials. */
export class LiveSourceAuthenticationRejectedError extends LiveSourceProbeBaseError {
  readonly code = 'LIVE_SOURCE_AUTHENTICATION_REJECTED' as const;

  constructor() {
    super('Live source rejected the supplied credentials');
    this.name = 'LiveSourceAuthenticationRejectedError';
  }
}
