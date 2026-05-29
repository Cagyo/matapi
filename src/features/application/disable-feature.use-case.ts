import { Inject, Injectable } from '@nestjs/common';
import { Feature } from '../domain/feature.entity';
import { FeatureAlreadyDisabledError } from '../domain/errors/feature-already-disabled.error';
import { UnknownFeatureError } from '../domain/errors/unknown-feature.error';
import { isKnownFeature } from '../domain/feature-catalog';
import {
  FEATURE_REPOSITORY,
  FeatureRepositoryPort,
} from '../domain/ports/feature-repository.port';

/**
 * Spec 17 — `/feature disable <name>` (admin only).
 *
 * Flips the persisted `enabled` flag to `false`; the running module is unloaded
 * on the next restart. A feature without a row (deps never installed) is
 * already effectively disabled.
 */
@Injectable()
export class DisableFeatureUseCase {
  constructor(
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepositoryPort,
  ) {}

  async execute(name: string): Promise<Feature> {
    if (!isKnownFeature(name)) throw new UnknownFeatureError(name);
    const feature = await this.features.findByName(name);
    if (!feature?.enabled) {
      throw new FeatureAlreadyDisabledError(name);
    }
    return this.features.setEnabled(name, false);
  }
}
