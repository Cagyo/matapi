export class DriveProviderResponseError extends Error {
  readonly code = 'DRIVE_PROVIDER_RESPONSE' as const;

  constructor() {
    super('Drive provider response was invalid');
    this.name = 'DriveProviderResponseError';
  }
}
