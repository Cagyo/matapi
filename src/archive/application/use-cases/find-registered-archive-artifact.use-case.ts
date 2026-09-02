import { Inject, Injectable } from '@nestjs/common';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
} from '../ports/archive-artifact-repository.port';
import type {
  ArchiveRegistrationLookupInput,
  ArchiveRegistrationLookupPort,
} from '../ports/archive-registration-lookup.port';

/** Publishes a minimal durable-registration lookup without exposing persistence. */
@Injectable()
export class FindRegisteredArchiveArtifactUseCase implements ArchiveRegistrationLookupPort {
  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly artifacts: Pick<ArchiveArtifactRepositoryPort, 'findRegisteredSource'>,
  ) {}

  findKnown(
    input: ArchiveRegistrationLookupInput,
  ): Promise<{ artifactId: string } | null> {
    return this.artifacts.findRegisteredSource(input);
  }
}
