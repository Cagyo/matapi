export class DriveTemporaryUnavailableError extends Error {
  readonly code: "DRIVE_TEMPORARY_UNAVAILABLE" | "DRIVE_FOLDER_DISCOVERY_UNCERTAIN" = "DRIVE_TEMPORARY_UNAVAILABLE";

  constructor(message = "Drive is temporarily unavailable") {
    super(message);
    this.name = "DriveTemporaryUnavailableError";
  }
}
