export class DriveReauthorizationRequiredError extends Error {
  readonly code = "DRIVE_REAUTHORIZATION_REQUIRED" as const;

  constructor(message = "Drive reauthorization is required") {
    super(message);
    this.name = "DriveReauthorizationRequiredError";
  }
}
