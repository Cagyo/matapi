import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Feature } from '../domain/feature.entity';
import { MANAGEABLE_FEATURE_NAMES } from '../domain/manageable-feature';
import { FEATURE_QUERY, type FeatureQueryPort } from '../domain/ports/feature-query.port';
import type { FeatureReadinessBarrierPort } from '../domain/ports/feature-readiness-barrier.port';
import { featureFailureCode } from './feature-failure-code';
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

  /**
   * The barrier must settle, never reject: every waiter — `SensorRegistryService`
   * and every feature-gated bot command — re-reads the repository itself once it
   * opens, so a rejection here would strand them for the process lifetime rather
   * than degrade one boot pass. The cost is that gating turns optimistic:
   * `FeatureAvailabilityService.requireReady` passes on a falsy
   * `attentionReason`, so a feature broken since the previous run — or a freshly
   * seeded row that has never been verified — is admitted and the bot command
   * proceeds into it. Readiness is re-verified on enable, on post-install
   * reconciliation, and on demand from `/feature`.
   */
  private async verifyInstalledFeatures(): Promise<void> {
    let rows: Feature[];
    try {
      rows = await this.features.listAll();
    } catch (error) {
      this.logger.error(`Feature readiness verification skipped: ${featureFailureCode(error)}`);
      return;
    }
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
