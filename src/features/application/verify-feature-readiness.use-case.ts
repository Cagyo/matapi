import { Inject, Injectable } from '@nestjs/common';
import { isManageableFeature, type ManageableFeatureName } from '../domain/manageable-feature';
import { FeatureVerificationError } from '../domain/errors/feature-verification.error';
import { UnknownFeatureError } from '../domain/errors/unknown-feature.error';
import {
  FEATURE_READINESS,
  type FeatureReadinessPort,
  type FeatureReadinessResult,
} from '../domain/ports/feature-readiness.port';
import {
  FEATURE_REPOSITORY,
  type FeatureRepositoryPort,
} from '../domain/ports/feature-repository.port';

export type FeatureReadinessSource = 'boot' | 'mutation' | 'post-install' | 'manual';

@Injectable()
export class VerifyFeatureReadinessUseCase {
  constructor(
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepositoryPort,
    @Inject(FEATURE_READINESS) private readonly readiness: FeatureReadinessPort,
  ) {}

  async execute(input: {
    name: string;
    source: FeatureReadinessSource;
  }): Promise<FeatureReadinessResult> {
    if (!isManageableFeature(input.name)) throw new UnknownFeatureError(input.name);
    const name: ManageableFeatureName = input.name;
    const result = await this.readiness.verify(name);
    if (input.source === 'post-install') return result;

    const feature = await this.features.findByName(name);
    if (result.ready) {
      if (input.source !== 'mutation' && feature?.installed) {
        await this.features.setAttention(name, null);
      }
      return result;
    }
    if (feature) await this.features.setAttention(name, 'readiness-failed');
    throw new FeatureVerificationError(name, 'readiness-failed');
  }
}
