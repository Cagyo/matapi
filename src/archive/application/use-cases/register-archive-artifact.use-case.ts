import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ArchiveArtifact, RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
} from '../ports/archive-artifact-repository.port';
import type { ArchiveRegistrationPort } from '../ports/archive-registration.port';
import type { ClockPort } from '../../../events/domain/ports/clock.port';
import {
  ArchiveWakeService,
  DEFAULT_ARCHIVE_WAKE_SERVICE,
} from '../archive-wake.service';

/** Registers an immutable artifact without exposing archive persistence to callers. */
@Injectable()
export class RegisterArchiveArtifactUseCase implements ArchiveRegistrationPort {
  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly artifacts: ArchiveArtifactRepositoryPort,
    @Optional()
    private readonly clock: ClockPort = { now: () => new Date() },
    @Optional()
    private readonly wake: ArchiveWakeService = DEFAULT_ARCHIVE_WAKE_SERVICE,
  ) {}

  async register(descriptor: RegisterArchiveArtifact): Promise<ArchiveArtifact> {
    const artifact = await this.artifacts.register(descriptor);
    const registeredAtMs = this.clock.now().getTime();
    for (;;) {
      const state = await this.artifacts.readSchedulerState();
      if (await this.artifacts.compareAndSetSchedulerState(state.revision, {
        lastArtifactRegistrationSuccessMs: registeredAtMs,
      })) break;
    }
    this.wake.wake();
    return artifact;
  }
}
