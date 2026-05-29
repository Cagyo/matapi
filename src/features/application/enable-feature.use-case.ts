import { Inject, Injectable } from '@nestjs/common';
import { Feature } from '../domain/feature.entity';
import { FeatureAlreadyEnabledError } from '../domain/errors/feature-already-enabled.error';
import { FeatureNotInstalledError } from '../domain/errors/feature-not-installed.error';
import { UnknownFeatureError } from '../domain/errors/unknown-feature.error';
import { isKnownFeature } from '../domain/feature-catalog';
import {
  FEATURE_REPOSITORY,
  FeatureRepositoryPort,
} from '../domain/ports/feature-repository.port';

/**
 * Spec 17 — `/feature enable <name>` (admin only).
 *
 * Only flips the persisted `enabled` flag; the running module is (un)loaded on
 * the next restart. The bot never installs system dependencies — a feature
 * whose deps are absent (`installed = false`, or no row at all) is rejected.
 */
@Injectable()
export class EnableFeatureUseCase {
  constructor(
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepositoryPort,
  ) {}

  async execute(name: string): Promise<Feature> {
    if (!isKnownFeature(name)) throw new UnknownFeatureError(name);
    const feature = await this.features.findByName(name);
    if (!feature?.installed) {
      throw new FeatureNotInstalledError(name);
    }
    if (feature.enabled) throw new FeatureAlreadyEnabledError(name);
    return this.features.setEnabled(name, true);
  }
}
