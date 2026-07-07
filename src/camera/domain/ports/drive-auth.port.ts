export const DRIVE_AUTH = Symbol('DRIVE_AUTH');

export interface DriveAuthPort {
  /** Replace the rclone [gdrive] section with the provided INI text. */
  updateConfig(configSnippet: string): Promise<void>;
  /** Restore the rclone.conf backup created by the last updateConfig call. */
  restoreBackup(): Promise<void>;
}
