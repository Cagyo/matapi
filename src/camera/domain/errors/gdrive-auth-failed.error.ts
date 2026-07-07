export class GdriveAuthFailedError extends Error {
  readonly code = 'GDRIVE_AUTH_FAILED' as const;
  constructor(readonly reason: string) {
    super(`Failed to update Drive auth: ${reason}`);
    this.name = 'GdriveAuthFailedError';
  }
}
