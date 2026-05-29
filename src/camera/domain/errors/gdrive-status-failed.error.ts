export class GdriveStatusFailedError extends Error {
  readonly code = 'GDRIVE_STATUS_FAILED' as const;
  constructor(readonly reason: string) {
    super(`Failed to check Drive status: ${reason}`);
    this.name = 'GdriveStatusFailedError';
  }
}
