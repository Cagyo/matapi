export class DriveQuotaExceededError extends Error {
  readonly code = "DRIVE_QUOTA_EXCEEDED" as const;

  constructor(message = "Drive quota is exceeded") {
    super(message);
    this.name = "DriveQuotaExceededError";
  }
}
