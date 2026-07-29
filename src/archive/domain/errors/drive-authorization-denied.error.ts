export class DriveAuthorizationDeniedError extends Error {
  readonly code = "DRIVE_AUTHORIZATION_DENIED" as const;

  constructor(message = "Drive authorization was denied") {
    super(message);
    this.name = "DriveAuthorizationDeniedError";
  }
}
