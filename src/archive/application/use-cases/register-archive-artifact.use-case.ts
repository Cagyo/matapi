import { Inject, Injectable } from '@nestjs/common';
import type { ArchiveArtifact, RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
} from '../ports/archive-artifact-repository.port';
import type { ArchiveRegistrationPort } from '../ports/archive-registration.port';

/** Registers an immutable artifact without exposing archive persistence to callers. */
@Injectable()
export class RegisterArchiveArtifactUseCase implements ArchiveRegistrationPort {
  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly artifacts: ArchiveArtifactRepositoryPort,
  ) {}

  register(descriptor: RegisterArchiveArtifact): Promise<ArchiveArtifact> {
    return this.artifacts.register(descriptor);
  }
}
