export type ArchiveSourceFilesystemOperation = 'stat' | 'read';

export type ArchiveSourceFilesystemErrorCode =
  | 'archive_source_missing'
  | 'archive_source_access_denied'
  | 'archive_source_io_failure'
  | 'archive_source_unavailable';

/** Sanitized local-source failure safe for application-layer handling and logs. */
export class ArchiveSourceFilesystemError extends Error {
  constructor(
    readonly code: ArchiveSourceFilesystemErrorCode,
    readonly operation: ArchiveSourceFilesystemOperation,
  ) {
    super('Archive source filesystem operation failed');
    this.name = 'ArchiveSourceFilesystemError';
  }
}
