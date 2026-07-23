import { Module } from '@nestjs/common';
import { DisableFeatureUseCase } from './application/disable-feature.use-case';
import { EnableFeatureUseCase } from './application/enable-feature.use-case';
import { ListFeaturesUseCase } from './application/list-features.use-case';
import { ListManageableFeaturesUseCase } from './application/list-manageable-features.use-case';
import { GetFeatureDetailUseCase } from './application/get-feature-detail.use-case';
import { VerifyFeatureReadinessUseCase } from './application/verify-feature-readiness.use-case';
import { FeatureAvailabilityService } from './application/feature-availability.service';
import { FeatureReadinessBootService } from './application/feature-readiness-boot.service';
import { FEATURE_QUERY } from './domain/ports/feature-query.port';
import { FEATURE_REPOSITORY } from './domain/ports/feature-repository.port';
import { DrizzleFeatureQuery } from './infrastructure/drizzle-feature.query';
import { DrizzleFeatureRepository } from './infrastructure/drizzle-feature.repository';
import { FeatureSeederService } from './application/feature-seeder.service';
import { FeatureDisableLifecycleRegistry } from './application/feature-disable-lifecycle-registry.service';
import { FEATURE_DISABLE_LIFECYCLE } from './domain/ports/feature-disable-lifecycle.port';
import { FEATURE_INSTALL_JOB_REPOSITORY } from './domain/ports/feature-install-job.repository.port';
import { FEATURE_READINESS } from './domain/ports/feature-readiness.port';
import { FEATURE_AVAILABILITY } from './domain/ports/feature-availability.port';
import { FEATURE_READINESS_BARRIER } from './domain/ports/feature-readiness-barrier.port';
import { DrizzleFeatureInstallJobRepository } from './infrastructure/drizzle-feature-install-job.repository';
import { DigitalReadinessAdapter } from './infrastructure/readiness/digital-readiness.adapter';
import { UartReadinessAdapter } from './infrastructure/readiness/uart-readiness.adapter';
import { ZigbeeReadinessAdapter } from './infrastructure/readiness/zigbee-readiness.adapter';
import { MotionReadinessAdapter } from './infrastructure/readiness/motion-readiness.adapter';
import { RtspReadinessAdapter } from './infrastructure/readiness/rtsp-readiness.adapter';
import { FeatureReadinessRouter } from './infrastructure/readiness/feature-readiness.router';

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
    { provide: FEATURE_INSTALL_JOB_REPOSITORY, useClass: DrizzleFeatureInstallJobRepository },
    {
      provide: FEATURE_READINESS,
      useFactory: () => new FeatureReadinessRouter({
        digital: new DigitalReadinessAdapter(),
        uart: new UartReadinessAdapter(),
        zigbee: new ZigbeeReadinessAdapter(),
        motion: new MotionReadinessAdapter(),
        rtsp: new RtspReadinessAdapter(),
      }),
    },
    FeatureDisableLifecycleRegistry,
    {
      provide: FEATURE_DISABLE_LIFECYCLE,
      useExisting: FeatureDisableLifecycleRegistry,
    },
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    VerifyFeatureReadinessUseCase,
    FeatureReadinessBootService,
    { provide: FEATURE_READINESS_BARRIER, useExisting: FeatureReadinessBootService },
    FeatureAvailabilityService,
    { provide: FEATURE_AVAILABILITY, useExisting: FeatureAvailabilityService },
    ListManageableFeaturesUseCase,
    GetFeatureDetailUseCase,
    ListFeaturesUseCase,
    FeatureSeederService,
  ],
  exports: [
    FEATURE_QUERY,
    FEATURE_AVAILABILITY,
    FEATURE_DISABLE_LIFECYCLE,
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    ListFeaturesUseCase,
    ListManageableFeaturesUseCase,
    GetFeatureDetailUseCase,
  ],
})
export class FeatureModule {}
