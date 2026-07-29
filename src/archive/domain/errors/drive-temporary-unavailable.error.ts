export class DriveTemporaryUnavailableError extends Error {
  readonly code = "DRIVE_TEMPORARY_UNAVAILABLE" as const;

  constructor(message = "Drive is temporarily unavailable") {
    super(message);
    this.name = "DriveTemporaryUnavailableError";
  }
}
