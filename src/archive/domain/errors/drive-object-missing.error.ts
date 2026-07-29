export class DriveObjectMissingError extends Error {
  readonly code = "DRIVE_OBJECT_MISSING" as const;

  constructor(message = "Drive object is missing") {
    super(message);
    this.name = "DriveObjectMissingError";
  }
}
