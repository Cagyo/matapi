export const DRIVE_STATUS = Symbol('DRIVE_STATUS');

/** Drive quota snapshot from `rclone about` (spec 15). */
export interface DriveQuota {
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
}

/**
 * Reports Google Drive remote quota (spec 15). The production adapter runs
 * `rclone about <remote>:` and parses the JSON output.
 *
 * Throws `GdriveNotInstalledError`, `GdriveNotConfiguredError`, or
 * `GdriveStatusFailedError`.
 */
export interface DriveStatusPort {
  about(): Promise<DriveQuota>;
}
