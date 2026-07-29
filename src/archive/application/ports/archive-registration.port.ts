import type { ArchiveArtifact, RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';

/** Cross-context registration seam for immutable local archive sources. */
export const ARCHIVE_REGISTRATION = Symbol('ARCHIVE_REGISTRATION');

export interface ArchiveRegistrationPort {
  register(descriptor: RegisterArchiveArtifact): Promise<ArchiveArtifact>;
}
