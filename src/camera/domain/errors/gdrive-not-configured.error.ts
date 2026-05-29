export class GdriveNotConfiguredError extends Error {
  readonly code = 'GDRIVE_NOT_CONFIGURED' as const;
  constructor() {
    super('Google Drive not configured');
    this.name = 'GdriveNotConfiguredError';
  }
}
