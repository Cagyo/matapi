export const ARCHIVE_VERIFICATION = Symbol('ARCHIVE_VERIFICATION');

export type ArchiveVerificationReason =
  | 'verified'
  | 'no-current-attempt'
  | 'retired-generation'
  | 'busy'
  | 'missing'
  | 'detached'
  | 'conflict'
  | 'local-changed';

export interface ArchiveVerification {
  artifactId: string;
  cleanupSafe: boolean;
  webViewLink: string | null;
  reason: ArchiveVerificationReason;
}

/** Published cross-context safety check for cleanup and private link fallback. */
export interface ArchiveVerificationPort {
  inspect(artifactId: string): Promise<ArchiveVerification>;
}
