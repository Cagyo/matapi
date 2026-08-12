export class DriveSetupExpiredError extends Error {
  readonly code = 'DRIVE_SETUP_EXPIRED' as const;

  constructor() {
    super('Drive setup expired');
    this.name = 'DriveSetupExpiredError';
  }
}
