export class DriveRateLimitedError extends Error {
  readonly code = "DRIVE_RATE_LIMITED" as const;

  constructor(readonly detail: {
    retryAfterMs: number | null;
    sessionUsable: boolean;
    operationPhase: 'metadata' | 'session-create' | 'session-query' | 'session-chunk';
  } = { retryAfterMs: null, sessionUsable: true, operationPhase: 'metadata' }) {
    super("Drive rate limit was reached");
    this.name = "DriveRateLimitedError";
  }
}
