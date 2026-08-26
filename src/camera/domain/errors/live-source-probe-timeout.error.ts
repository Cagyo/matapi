/** The probe exhausted its own monotonic deadline before the source was verified. */
export class LiveSourceProbeTimeoutError extends Error {
  readonly code = 'LIVE_SOURCE_PROBE_TIMEOUT' as const;

  constructor() {
    super('Live source probe timed out');
    this.name = 'LiveSourceProbeTimeoutError';
  }
}
