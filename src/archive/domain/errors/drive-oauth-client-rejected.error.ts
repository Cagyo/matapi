export class DriveOAuthClientRejectedError extends Error {
  readonly code = 'DRIVE_OAUTH_CLIENT_REJECTED' as const;

  constructor() {
    super('Drive OAuth client was rejected');
    this.name = 'DriveOAuthClientRejectedError';
  }
}
