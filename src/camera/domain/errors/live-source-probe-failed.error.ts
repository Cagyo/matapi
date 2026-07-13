export class LiveSourceProbeFailedError extends Error {
  readonly code = 'LIVE_SOURCE_PROBE_FAILED' as const;

  constructor() {
    super('Live source probe failed');
    this.name = 'LiveSourceProbeFailedError';
  }
}
