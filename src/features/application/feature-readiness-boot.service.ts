import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Feature } from '../domain/feature.entity';
import { MANAGEABLE_FEATURE_NAMES } from '../domain/manageable-feature';
import { FEATURE_QUERY, type FeatureQueryPort } from '../domain/ports/feature-query.port';
import type { FeatureReadinessBarrierPort } from '../domain/ports/feature-readiness-barrier.port';
import { VerifyFeatureReadinessUseCase } from './verify-feature-readiness.use-case';

const FEATURE_VERIFICATION_FAILED = 'FEATURE_VERIFICATION_FAILED';
const SAFE_FAILURE_CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Path-free discriminator for the listing failure. Node and SQLite error codes
 * (`SQLITE_BUSY`, `SQLITE_CANTOPEN`) and domain error codes are safe by
 * construction; the character guard rejects anything else, which is how a code
 * carrying a database path degrades to the fixed token.
 */
function listingFailureCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : null;
  const candidate = code
    ?? (error instanceof Error && error.name !== 'Error' ? error.name : null);
  return candidate !== null && SAFE_FAILURE_CODE.test(candidate)
    ? candidate
    : FEATURE_VERIFICATION_FAILED;
}

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
   * than degrade one boot pass. Skipping the pass leaves the persisted
   * `attentionReason` from the previous run in place; readiness is re-verified on
   * enable, on post-install reconciliation, and on demand from `/feature`.
   */
  private async verifyInstalledFeatures(): Promise<void> {
    let rows: Feature[];
    try {
      rows = await this.features.listAll();
    } catch (error) {
      this.logger.error(`Feature readiness verification skipped: ${listingFailureCode(error)}`);
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
