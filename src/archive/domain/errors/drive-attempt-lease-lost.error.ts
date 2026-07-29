export class DriveAttemptLeaseLostError extends Error {
  readonly code = "DRIVE_ATTEMPT_LEASE_LOST" as const;

  constructor(message = "Drive object attempt lease was lost") {
    super(message);
    this.name = "DriveAttemptLeaseLostError";
  }
}
