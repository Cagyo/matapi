import { Module } from '@nestjs/common';
import { DisableFeatureUseCase } from './application/disable-feature.use-case';
import { EnableFeatureUseCase } from './application/enable-feature.use-case';
import { ListFeaturesUseCase } from './application/list-features.use-case';
import { FEATURE_QUERY } from './domain/ports/feature-query.port';
import { FEATURE_REPOSITORY } from './domain/ports/feature-repository.port';
import { DrizzleFeatureQuery } from './infrastructure/drizzle-feature.query';
import { DrizzleFeatureRepository } from './infrastructure/drizzle-feature.repository';
import { FeatureSeederService } from './application/feature-seeder.service';
import { FeatureDisableLifecycleRegistry } from './application/feature-disable-lifecycle-registry.service';
import { FEATURE_DISABLE_LIFECYCLE } from './domain/ports/feature-disable-lifecycle.port';

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
    FeatureDisableLifecycleRegistry,
    {
      provide: FEATURE_DISABLE_LIFECYCLE,
      useExisting: FeatureDisableLifecycleRegistry,
    },
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    ListFeaturesUseCase,
    FeatureSeederService,
  ],
  exports: [
    FEATURE_QUERY,
    FEATURE_DISABLE_LIFECYCLE,
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    ListFeaturesUseCase,
  ],
})
export class FeatureModule {}
