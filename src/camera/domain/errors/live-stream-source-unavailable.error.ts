export class LiveStreamSourceUnavailableError extends Error {
  readonly code = 'LIVE_STREAM_SOURCE_UNAVAILABLE' as const;

  constructor() {
    super('Live stream source is unavailable');
    this.name = 'LiveStreamSourceUnavailableError';
  }
}
