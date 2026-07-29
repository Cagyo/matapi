export class DriveObjectDetachedError extends Error {
  readonly code = "DRIVE_OBJECT_DETACHED" as const;

  constructor(message = "Drive object is detached from its manifest") {
    super(message);
    this.name = "DriveObjectDetachedError";
  }
}
