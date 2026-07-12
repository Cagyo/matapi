export class LiveStreamExpiredError extends Error {
  readonly code = 'LIVE_STREAM_EXPIRED' as const;

  constructor() {
    super('Live stream has expired');
    this.name = 'LiveStreamExpiredError';
  }
}
