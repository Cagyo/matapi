export type DriveClientDocumentReason =
  | 'download-failed' | 'too-large' | 'invalid-utf8'
  | 'malformed-json' | 'invalid-credentials' | 'unsupported-client-type';

export class DriveClientDocumentError extends Error {
  readonly code = 'DRIVE_CLIENT_DOCUMENT' as const;

  constructor(readonly reason: DriveClientDocumentReason) {
    super('Drive client document is invalid');
    this.name = 'DriveClientDocumentError';
  }
}
