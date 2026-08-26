import { LiveSourceProbeBaseError } from './live-source-probe-base.error';

/** The live source connected but published no usable video stream. */
export class LiveSourceUnsupportedStreamError extends LiveSourceProbeBaseError {
  readonly code = 'LIVE_SOURCE_UNSUPPORTED_STREAM' as const;

  constructor() {
    super('Live source did not publish a supported video stream');
    this.name = 'LiveSourceUnsupportedStreamError';
  }
}
