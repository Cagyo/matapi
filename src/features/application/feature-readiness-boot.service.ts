import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MANAGEABLE_FEATURE_NAMES } from '../domain/manageable-feature';
import { FEATURE_QUERY, type FeatureQueryPort } from '../domain/ports/feature-query.port';
import type { FeatureReadinessBarrierPort } from '../domain/ports/feature-readiness-barrier.port';
import { VerifyFeatureReadinessUseCase } from './verify-feature-readiness.use-case';

@Injectable()
export class FeatureReadinessBootService implements FeatureReadinessBarrierPort, OnApplicationBootstrap {
  private readonly logger = new Logger(FeatureReadinessBootService.name);
  private initialVerification: Promise<void> | undefined;

  constructor(
    @Inject(FEATURE_QUERY)
    private readonly features: FeatureQueryPort,
    private readonly verify: VerifyFeatureReadinessUseCase,
  ) {}

  onApplicationBootstrap(): Promise<void> {
    return this.awaitInitialVerification();
  }

  awaitInitialVerification(): Promise<void> {
    this.initialVerification ??= this.verifyInstalledFeatures();
    return this.initialVerification;
  }

  private async verifyInstalledFeatures(): Promise<void> {
    const rows = await this.features.listAll();
    const enabled = new Set(
      rows
        .filter((feature) => feature.installed && feature.enabled)
        .map((feature) => feature.name),
    );
    await Promise.all(MANAGEABLE_FEATURE_NAMES.map(async (name) => {
      if (!enabled.has(name)) return;
      try {
        await this.verify.execute({ name, source: 'boot' });
      } catch {
        this.logger.warn(`Feature readiness verification failed: ${name}`);
      }
    }));
  }
}
