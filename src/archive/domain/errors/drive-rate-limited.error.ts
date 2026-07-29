export class DriveRateLimitedError extends Error {
  readonly code = "DRIVE_RATE_LIMITED" as const;

  constructor(message = "Drive rate limit was reached") {
    super(message);
    this.name = "DriveRateLimitedError";
  }
}
