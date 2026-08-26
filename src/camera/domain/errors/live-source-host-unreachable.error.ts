import { LiveSourceProbeBaseError } from './live-source-probe-base.error';

/** The live-source host resolved but refused, dropped, or never answered the connection. */
export class LiveSourceHostUnreachableError extends LiveSourceProbeBaseError {
  readonly code = 'LIVE_SOURCE_HOST_UNREACHABLE' as const;

  constructor() {
    super('Live source host did not accept the connection');
    this.name = 'LiveSourceHostUnreachableError';
  }
}
