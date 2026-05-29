import { Module } from '@nestjs/common';
import { FEATURE_QUERY } from './domain/ports/feature-query.port';
import { DrizzleFeatureQuery } from './infrastructure/drizzle-feature.query';

/**
 * Features composition root. Today it exposes only a read projection of the
 * `features` table for `/export_config` (spec 16). The `DB` token is global
 * (see `DatabaseModule`), so the Drizzle adapter binds unconditionally.
 */
@Module({
  providers: [{ provide: FEATURE_QUERY, useClass: DrizzleFeatureQuery }],
  exports: [FEATURE_QUERY],
})
export class FeatureModule {}
