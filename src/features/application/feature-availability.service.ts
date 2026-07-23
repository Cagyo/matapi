import { Inject, Injectable } from '@nestjs/common';
import { deriveFeatureStatus, type FeatureStatus } from '../domain/feature-status';
import type { ManageableFeatureName } from '../domain/manageable-feature';
import { FeatureUnavailableError } from '../domain/errors/feature-unavailable.error';
import {
  FEATURE_INSTALL_JOB_REPOSITORY,
  type FeatureInstallJobRepositoryPort,
} from '../domain/ports/feature-install-job.repository.port';
import {
  FEATURE_REPOSITORY,
  type FeatureRepositoryPort,
} from '../domain/ports/feature-repository.port';
import type { FeatureAvailabilityPort } from '../domain/ports/feature-availability.port';
import { FeatureReadinessBootService } from './feature-readiness-boot.service';

@Injectable()
export class FeatureAvailabilityService implements FeatureAvailabilityPort {
  constructor(
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepositoryPort,
    @Inject(FEATURE_INSTALL_JOB_REPOSITORY)
    private readonly jobs: FeatureInstallJobRepositoryPort,
    private readonly boot: FeatureReadinessBootService,
  ) {}

  awaitInitialVerification(): Promise<void> {
    return this.boot.awaitInitialVerification();
  }

  async inspect(name: ManageableFeatureName): Promise<FeatureStatus> {
    await this.awaitInitialVerification();
    const [feature, activeJob] = await Promise.all([
      this.features.findByName(name),
      this.jobs.findActive(),
    ]);
    return deriveFeatureStatus(feature ?? {
      name,
      installed: false,
      enabled: false,
      config: null,
      attentionReason: null,
    }, activeJob);
  }

  async requireReady(name: ManageableFeatureName): Promise<void> {
    await this.awaitInitialVerification();
    const status = await this.inspect(name);
    if (!status.installed || !status.enabled || !status.ready || status.attentionReason || status.busy) {
      throw new FeatureUnavailableError(name, status.display);
    }
  }
}
