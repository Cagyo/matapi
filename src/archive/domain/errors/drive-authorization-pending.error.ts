export class DriveAuthorizationPendingError extends Error {
  readonly code = "DRIVE_AUTHORIZATION_PENDING" as const;

  constructor(message = "Drive authorization is pending") {
    super(message);
    this.name = "DriveAuthorizationPendingError";
  }
}
