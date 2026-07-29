export class DriveLocalSourceChangedError extends Error {
  readonly code = "DRIVE_LOCAL_SOURCE_CHANGED" as const;

  constructor(message = "Local archive source changed") {
    super(message);
    this.name = "DriveLocalSourceChangedError";
  }
}
