import { LiveSourceProbeBaseError } from './live-source-probe-base.error';

export class LiveSourceProbeFailedError extends LiveSourceProbeBaseError {
  readonly code = 'LIVE_SOURCE_PROBE_FAILED' as const;

  constructor() {
    super('Live source probe failed');
    this.name = 'LiveSourceProbeFailedError';
  }
}
