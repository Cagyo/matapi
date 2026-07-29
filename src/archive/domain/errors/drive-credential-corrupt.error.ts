export class DriveCredentialCorruptError extends Error {
  readonly code = "DRIVE_CREDENTIAL_CORRUPT" as const;

  constructor(message = "Drive credential is corrupt") {
    super(message);
    this.name = "DriveCredentialCorruptError";
  }
}
