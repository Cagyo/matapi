export class GdriveUploadFailedError extends Error {
  readonly code = 'GDRIVE_UPLOAD_FAILED' as const;
  constructor(readonly reason: string) {
    super(`Drive sync failed: ${reason}`);
    this.name = 'GdriveUploadFailedError';
  }
}
