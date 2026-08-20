export type CompletedMotionVideoFilesystemOperation = 'inspect' | 'read-directory' | 'hash';

export type CompletedMotionVideoFilesystemErrorCode =
  | 'motion_fs_access_denied'
  | 'motion_fs_io_failure'
  | 'motion_fs_unavailable';

/** Sanitized filesystem failure that is safe to pass across the Camera boundary. */
export class CompletedMotionVideoFilesystemError extends Error {
  constructor(
    readonly code: CompletedMotionVideoFilesystemErrorCode,
    readonly operation: CompletedMotionVideoFilesystemOperation,
  ) {
    super('Motion filesystem operation failed');
    this.name = 'CompletedMotionVideoFilesystemError';
  }
}
