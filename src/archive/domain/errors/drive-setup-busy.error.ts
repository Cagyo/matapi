export class DriveSetupBusyError extends Error {
  readonly code = 'DRIVE_SETUP_BUSY' as const;

  constructor() {
    super('Another Drive setup is authorizing');
    this.name = 'DriveSetupBusyError';
  }
}
