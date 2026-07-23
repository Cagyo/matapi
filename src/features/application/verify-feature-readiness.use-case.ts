import { Inject, Injectable } from '@nestjs/common';
import { isManageableFeature, type ManageableFeatureName } from '../domain/manageable-feature';
import { FeatureVerificationError } from '../domain/errors/feature-verification.error';
import { FeatureStateChangedError } from '../domain/errors/feature-state-changed.error';
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
import type { FeatureAttentionReason } from '../domain/manageable-feature';

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
    expected?: {
      installed: boolean;
      enabled: boolean;
      attentionReason: FeatureAttentionReason | null;
    };
  }): Promise<FeatureReadinessResult> {
    if (!isManageableFeature(input.name)) throw new UnknownFeatureError(input.name);
    const name: ManageableFeatureName = input.name;
    if (input.expected && !await this.matches(name, input.expected)) {
      throw new FeatureStateChangedError(name);
    }
    const result = await this.readiness.verify(name);
    if (input.source === 'post-install') return result;

    const feature = await this.features.findByName(name);
    if (result.ready) {
      if (input.source !== 'mutation' && feature?.installed) {
        if (input.expected) {
          if (!await this.features.compareAndSetAttention({ name, expected: input.expected, attentionReason: null })) {
            throw new FeatureStateChangedError(name);
          }
        } else {
          await this.features.setAttention(name, null);
        }
      }
      return result;
    }
    if (feature) {
      if (input.expected) {
        if (!await this.features.compareAndSetAttention({ name, expected: input.expected, attentionReason: 'readiness-failed' })) {
          throw new FeatureStateChangedError(name);
        }
      } else {
        await this.features.setAttention(name, 'readiness-failed');
      }
    }
    throw new FeatureVerificationError(name, 'readiness-failed');
  }

  private async matches(
    name: ManageableFeatureName,
    expected: { installed: boolean; enabled: boolean; attentionReason: FeatureAttentionReason | null },
  ): Promise<boolean> {
    const feature = await this.features.findByName(name);
    return feature?.installed === expected.installed
      && feature.enabled === expected.enabled
      && feature.attentionReason === expected.attentionReason;
  }
}
