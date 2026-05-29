import { Module } from '@nestjs/common';
import { DisableFeatureUseCase } from './application/disable-feature.use-case';
import { EnableFeatureUseCase } from './application/enable-feature.use-case';
import { ListFeaturesUseCase } from './application/list-features.use-case';
import { FEATURE_QUERY } from './domain/ports/feature-query.port';
import { FEATURE_REPOSITORY } from './domain/ports/feature-repository.port';
import { DrizzleFeatureQuery } from './infrastructure/drizzle-feature.query';
import { DrizzleFeatureRepository } from './infrastructure/drizzle-feature.repository';

/**
 * Features composition root. Exposes a read projection of the `features` table
 * for `/export_config` (spec 16) and the `/feature enable|disable|list` toggle
 * use-cases (spec 17). The `DB` token is global (see `DatabaseModule`), so the
 * Drizzle adapters bind unconditionally.
 */
@Module({
  providers: [
    { provide: FEATURE_QUERY, useClass: DrizzleFeatureQuery },
    { provide: FEATURE_REPOSITORY, useClass: DrizzleFeatureRepository },
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    ListFeaturesUseCase,
  ],
  exports: [
    FEATURE_QUERY,
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    ListFeaturesUseCase,
  ],
})
export class FeatureModule {}
