export class DriveObjectConflictError extends Error {
  readonly code = "DRIVE_OBJECT_CONFLICT" as const;

  constructor(message = "Drive object conflicts with its immutable manifest") {
    super(message);
    this.name = "DriveObjectConflictError";
  }
}
