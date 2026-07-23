import { Module } from '@nestjs/common';
import { DisableFeatureUseCase } from './application/disable-feature.use-case';
import { EnableFeatureUseCase } from './application/enable-feature.use-case';
import { ListManageableFeaturesUseCase } from './application/list-manageable-features.use-case';
import { GetFeatureDetailUseCase } from './application/get-feature-detail.use-case';
import { VerifyFeatureReadinessUseCase } from './application/verify-feature-readiness.use-case';
import { FeatureAvailabilityService } from './application/feature-availability.service';
import { FeatureReadinessBootService } from './application/feature-readiness-boot.service';
import { FEATURE_QUERY } from './domain/ports/feature-query.port';
import { FEATURE_REPOSITORY } from './domain/ports/feature-repository.port';
import { FEATURE_SEED_CONFIG } from './domain/ports/feature-seed-config.port';
import { DrizzleFeatureQuery } from './infrastructure/drizzle-feature.query';
import { DrizzleFeatureRepository } from './infrastructure/drizzle-feature.repository';
import { FeatureSeederService } from './application/feature-seeder.service';
import { BeginFeatureInstallUseCase } from './application/begin-feature-install.use-case';
import { ReconcileFeatureInstallUseCase } from './application/reconcile-feature-install.use-case';
import { FeatureInstallRecoveryService } from './application/feature-install-recovery.service';
import { FeatureInstallOutcomeRegistryService } from './application/feature-install-outcome-registry.service';
import { FeatureDisableLifecycleRegistry } from './application/feature-disable-lifecycle-registry.service';
import { FEATURE_RUNTIME_LIFECYCLE } from './domain/ports/feature-runtime-lifecycle.port';
import { FEATURE_RESTART } from './domain/ports/feature-restart.port';
import { FEATURE_INSTALL_JOB_REPOSITORY } from './domain/ports/feature-install-job.repository.port';
import { FEATURE_INSTALL_REQUEST } from './domain/ports/feature-install-request.port';
import { FEATURE_INSTALL_RESULT } from './domain/ports/feature-install-result.port';
import { FEATURE_INSTALL_CONTROLLER } from './domain/ports/feature-install-controller.port';
import { FEATURE_INSTALL_OUTCOME_REGISTRY } from './domain/ports/feature-install-outcome.port';
import { FEATURE_CLOCK } from './domain/ports/feature-clock.port';
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
import { FixedFeatureRestartAdapter } from './infrastructure/fixed-feature-restart.adapter';
import { FsFeatureInstallRequestAdapter } from './infrastructure/fs-feature-install-request.adapter';
import { FsFeatureInstallResultAdapter } from './infrastructure/fs-feature-install-result.adapter';
import { SystemdFeatureInstallControllerAdapter } from './infrastructure/systemd-feature-install-controller.adapter';
import { SystemFeatureClockAdapter } from './infrastructure/system-feature-clock.adapter';
import { FsFeatureSeedConfigAdapter } from './infrastructure/fs-feature-seed-config.adapter';
import { PROCESS_RESTARTER, type ProcessRestarterPort } from '../system/domain/ports/process-restarter.port';
import { resolveSystemMode } from '../system/domain/system-mode';
import { Pm2ProcessRestarter } from '../system/infrastructure/pm2-process-restarter.adapter';
import { StubProcessRestarter } from '../system/infrastructure/stub-process-restarter.adapter';

const systemMode = resolveSystemMode();

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
    { provide: FEATURE_SEED_CONFIG, useClass: FsFeatureSeedConfigAdapter },
    { provide: FEATURE_INSTALL_JOB_REPOSITORY, useClass: DrizzleFeatureInstallJobRepository },
    { provide: FEATURE_INSTALL_REQUEST, useClass: FsFeatureInstallRequestAdapter },
    { provide: FEATURE_INSTALL_RESULT, useClass: FsFeatureInstallResultAdapter },
    { provide: FEATURE_INSTALL_CONTROLLER, useClass: SystemdFeatureInstallControllerAdapter },
    { provide: FEATURE_CLOCK, useClass: SystemFeatureClockAdapter },
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
    FeatureInstallOutcomeRegistryService,
    { provide: FEATURE_INSTALL_OUTCOME_REGISTRY, useExisting: FeatureInstallOutcomeRegistryService },
    {
      provide: FEATURE_RUNTIME_LIFECYCLE,
      useExisting: FeatureDisableLifecycleRegistry,
    },
    {
      provide: PROCESS_RESTARTER,
      useClass: systemMode === 'stub' ? StubProcessRestarter : Pm2ProcessRestarter,
    },
    {
      provide: FEATURE_RESTART,
      useFactory: (restarter: ProcessRestarterPort) => new FixedFeatureRestartAdapter(restarter),
      inject: [PROCESS_RESTARTER],
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
    FeatureSeederService,
    ReconcileFeatureInstallUseCase,
    FeatureInstallRecoveryService,
    BeginFeatureInstallUseCase,
  ],
  exports: [
    FEATURE_QUERY,
    FEATURE_AVAILABILITY,
    FEATURE_RUNTIME_LIFECYCLE,
    FEATURE_INSTALL_OUTCOME_REGISTRY,
    EnableFeatureUseCase,
    DisableFeatureUseCase,
    ListManageableFeaturesUseCase,
    GetFeatureDetailUseCase,
    BeginFeatureInstallUseCase,
    VerifyFeatureReadinessUseCase,
    ReconcileFeatureInstallUseCase,
    FeatureInstallRecoveryService,
  ],
})
export class FeatureModule {}
