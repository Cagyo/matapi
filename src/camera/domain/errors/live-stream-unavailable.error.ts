export class LiveStreamUnavailableError extends Error {
  readonly code = 'LIVE_STREAM_UNAVAILABLE' as const;

  constructor() {
    super('Live stream is unavailable');
    this.name = 'LiveStreamUnavailableError';
  }
}
