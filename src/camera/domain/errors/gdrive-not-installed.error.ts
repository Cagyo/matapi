export class GdriveNotInstalledError extends Error {
  readonly code = 'GDRIVE_NOT_INSTALLED' as const;
  constructor() {
    super('rclone is not installed');
    this.name = 'GdriveNotInstalledError';
  }
}
