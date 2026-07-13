export class InvalidLiveSourceError extends Error {
  readonly code = 'INVALID_LIVE_SOURCE' as const;

  constructor(reason: string) {
    super(`Invalid live source: ${reason}`);
    this.name = 'InvalidLiveSourceError';
  }
}
