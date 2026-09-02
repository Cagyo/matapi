export interface ArchiveRegistrationLookupInput {
  installationId: string;
  kind: 'motion_video';
  sourceIdentity: string;
  size: number;
  mtimeNs: string;
}

/** Provider-neutral read seam for an already-registered immutable source. */
export const ARCHIVE_REGISTRATION_LOOKUP = Symbol('ARCHIVE_REGISTRATION_LOOKUP');

export interface ArchiveRegistrationLookupPort {
  findKnown(input: ArchiveRegistrationLookupInput): Promise<{ artifactId: string } | null>;
}
