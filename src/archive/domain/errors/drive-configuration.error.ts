export class DriveConfigurationError extends Error {
  readonly code = "DRIVE_CONFIGURATION" as const;

  constructor(message = "Drive configuration is invalid") {
    super(message);
    this.name = "DriveConfigurationError";
  }
}
