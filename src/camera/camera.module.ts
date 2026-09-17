import { Logger, Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { ArchiveModule } from '../archive/archive.module';
import { ARCHIVE_REGISTRATION, type ArchiveRegistrationPort } from '../archive/application/ports/archive-registration.port';
import {
  ARCHIVE_REGISTRATION_LOOKUP,
  type ArchiveRegistrationLookupPort,
} from '../archive/application/ports/archive-registration-lookup.port';
import {
  ARCHIVE_RUNTIME_SIGNAL,
  type ArchiveRuntimeSignalPort,
} from '../archive/application/ports/archive-runtime-signal.port';
import { ArchiveSchedulerHooksService } from '../archive/application/archive-scheduler.service';
import { loadDefaults } from '../config/config.loader';
import { AppDatabase, DB, DatabaseModule } from '../database/database.module';
import { EventModule } from '../events/event.module';
import { FeatureModule } from '../features/feature.module';
import {
  FEATURE_RUNTIME_LIFECYCLE,
  type FeatureRuntimeLifecycleRegistryPort,
} from '../features/domain/ports/feature-runtime-lifecycle.port';
import {
  FEATURE_QUERY,
  type FeatureQueryPort,
} from '../features/domain/ports/feature-query.port';
import {
  FEATURE_AVAILABILITY,
  type FeatureAvailabilityPort,
} from '../features/domain/ports/feature-availability.port';
import { SystemModule } from '../system/system.module';
import { AdminAlertService } from './application/admin-alert.service';
import { BrowseMotionEventsUseCase } from './application/browse-motion-events.use-case';
import { CameraSourceAuthorizationRegistry } from './application/camera-source-authorization-registry.service';
import { CameraStatusUseCase } from './application/camera-status.use-case';
import { CleanupCoordinatorService } from './application/cleanup-coordinator.service';
import { CleanupLocalStorageUseCase } from './application/cleanup-local-storage.use-case';
import { DisableMotionUseCase } from './application/disable-motion.use-case';
import { FeatureCameraRuntimeLifecycleService } from './application/feature-camera-runtime-lifecycle.service';
import { EnableMotionUseCase } from './application/enable-motion.use-case';
import { GetMotionPhotoUseCase } from './application/get-motion-photo.use-case';
import { GetMotionVideoUseCase } from './application/get-motion-video.use-case';
import { GetSnapshotUseCase } from './application/get-snapshot.use-case';
import { GetRtspSourceOverviewUseCase } from './application/get-rtsp-source-overview.use-case';
import { ListCamerasUseCase } from './application/list-cameras.use-case';
import { AttachRtspSourceUseCase } from './application/attach-rtsp-source.use-case';
import { ConfigureLiveSourceUseCase } from './application/configure-live-source.use-case';
import { CreateRtspCameraUseCase } from './application/create-rtsp-camera.use-case';
import { ListLiveSourcesUseCase } from './application/list-live-sources.use-case';
import { RemoveRtspSourceUseCase } from './application/remove-rtsp-source.use-case';
import { ReplaceRtspSourceUseCase } from './application/replace-rtsp-source.use-case';
import { RtspSourceMutationService } from './application/rtsp-source-mutation.service';
import { TestRtspSourceUseCase } from './application/test-rtsp-source.use-case';
import { ListMotionEventsUseCase } from './application/list-motion-events.use-case';
import { LiveStreamMessageCleanupService } from './application/live-stream-message-cleanup.service';
import { LiveStreamSessionService } from './application/live-stream-session.service';
import { LiveSourceCredentialRotationCoordinator } from './application/live-source-credential-rotation-coordinator.service';
import { LiveStreamSourceResolverService } from './application/live-stream-source-resolver.service';
import { MotionWatcherService } from './application/motion-watcher.service';
import { OpenLiveStreamUseCase } from './application/open-live-stream.use-case';
import { LiveViewStartGate } from './application/live-view-start-gate.service';
import { RtspSourceStartGate } from './application/rtsp-source-start-gate.service';
import { RecordMotionEndUseCase } from './application/record-motion-end.use-case';
import { RecordMotionStartUseCase } from './application/record-motion-start.use-case';
import { RecordSnapshotUseCase } from './application/record-snapshot.use-case';
import { CompletedMotionVideoRecoveryScheduler } from './application/completed-motion-video-recovery.scheduler';
import { RegisterCompletedMotionVideosUseCase } from './application/register-completed-motion-videos.use-case';
import { StopLiveStreamUseCase } from './application/stop-live-stream.use-case';
import { TriggerCleanUseCase } from './application/trigger-clean.use-case';
import {
  CAMERA_MODE,
  LIVE_STREAM_OPTIONS,
  LIVE_SOURCE_PROBE_OPTIONS,
  liveStreamOptionsFromEnv,
  type LiveStreamOptions,
} from './camera.tokens';
import { ADMIN_ALERT, type AdminAlertPort } from './domain/ports/admin-alert.port';
import { CAMERA_CLOCK } from './domain/ports/camera-clock.port';
import { CAMERA_ID_GENERATOR } from './domain/ports/camera-id-generator.port';
import { CAMERA_SOURCE_AUTHORIZATION } from './domain/ports/camera-source-authorization.port';
import {
  LIVE_STREAM_CAPABILITY,
  type LiveStreamCapabilityPort,
} from './domain/ports/live-stream-capability.port';
import {
  LIVE_STREAM_GATEWAY,
  type LiveStreamGatewayPort,
} from './domain/ports/live-stream-gateway.port';
import {
  LIVE_STREAM_LEASE,
  type LiveStreamLeasePort,
} from './domain/ports/live-stream-lease.port';
import {
  LIVE_STREAM_MESSAGE_CLEANUP,
  type LiveStreamMessageCleanupPort,
} from './domain/ports/live-stream-message-cleanup.port';
import { LOCAL_STORAGE } from './domain/ports/local-storage.port';
import {
  LIVE_SOURCE_CREDENTIAL,
  type LiveSourceCredentialPort,
} from './domain/ports/live-source-credential.port';
import {
  LIVE_SOURCE_PROBE,
} from './domain/ports/live-source-probe.port';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
} from './domain/ports/live-source-repository.port';
import { LIVE_SOURCE_POLICY_EVALUATOR } from './domain/ports/live-source-policy-evaluator.port';
import { LIVE_SOURCE_SESSION_CONTROL } from './domain/ports/live-source-session-control.port';
import { MEDIA_FILE } from './domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from './domain/ports/media-repository.port';
import { MEDIA_WRITER } from './domain/ports/media-writer.port';
import { COMPLETED_MOTION_VIDEO, type CompletedMotionVideoPort } from './domain/ports/completed-motion-video.port';
import { MOTION_ALERT } from './domain/ports/motion-alert.port';
import { MOTION_CONTROL } from './domain/ports/motion-control.port';
import {
  MONOTONIC_CLOCK,
  type MonotonicClockPort,
} from './domain/ports/monotonic-clock.port';
import { RETENTION_PRUNE } from './domain/ports/retention-prune.port';
import {
  RTSP_SOURCE_CONFIGURATION,
  type RtspSourceConfigurationPort,
} from './domain/ports/rtsp-source-configuration.port';
import { SNAPSHOT } from './domain/ports/snapshot.port';
import { STREAM_EGRESS, type StreamEgressPort } from './domain/ports/stream-egress.port';
import { STREAM_SANDBOX, type StreamSandboxPort } from './domain/ports/stream-sandbox.port';
import { RTSP_RUNTIME_COORDINATOR, type RtspRuntimeCoordinatorPort } from './domain/ports/rtsp-runtime-coordinator.port';
import { RTSP_STREAM_RUNTIME, type RtspStreamRuntimePort } from './domain/ports/rtsp-stream-runtime.port';
import { DrizzleMediaRepository } from './infrastructure/drizzle-media.repository';
import { DrizzleLiveSourceRepository } from './infrastructure/drizzle-live-source.repository';
import { CryptoCameraIdGeneratorAdapter } from './infrastructure/crypto-camera-id-generator.adapter';
import { SystemCameraClockAdapter } from './infrastructure/system-camera-clock.adapter';
import { SystemLiveSourcePolicyEvaluatorAdapter } from './infrastructure/system-live-source-policy-evaluator.adapter';
import { DrizzleRtspSourceConfigurationAdapter } from './infrastructure/drizzle-rtsp-source-configuration.adapter';
import { InMemoryRtspSourceConfigurationAdapter } from './infrastructure/in-memory-rtsp-source-configuration.adapter';
import { InMemoryLiveSourceRepository } from './infrastructure/in-memory-live-source.repository';
import { liveSourceCredentialFromEnvironment } from './infrastructure/aes-gcm-live-source-credential.adapter';
import {
  FfmpegLiveSourceProbeAdapter,
  liveSourceProbeOptionsFromEnvironment,
  type FfmpegLiveSourceProbeOptions,
} from './infrastructure/ffmpeg-live-source-probe.adapter';
import { UnavailableStreamEgressAdapter } from './infrastructure/unavailable-stream-egress.adapter';
import { UnavailableStreamSandboxAdapter } from './infrastructure/unavailable-stream-sandbox.adapter';
import { NftStreamEgressAdapter, UnixLocalStreamHelperClient } from './infrastructure/nft-stream-egress.adapter';
import { SystemdFfmpegStreamAdapter } from './infrastructure/systemd-ffmpeg-stream.adapter';
import { RestrictedRtspStreamRuntimeAdapter } from './infrastructure/restricted-rtsp-stream-runtime.adapter';
import { UnavailableRtspStreamRuntimeAdapter } from './infrastructure/unavailable-rtsp-stream-runtime.adapter';
import { UnavailableRtspRuntimeCoordinatorAdapter } from './infrastructure/unavailable-rtsp-runtime-coordinator.adapter';
import { LiveStreamSessionControlAdapter } from './infrastructure/live-stream-session-control.adapter';
import { DrizzleRetentionPruneAdapter } from './infrastructure/drizzle-retention-prune.adapter';
import { EventsMotionAlertAdapter } from './infrastructure/events-motion-alert.adapter';
import { FfmpegSnapshotAdapter } from './infrastructure/ffmpeg-snapshot.adapter';
import { AvailableLiveStreamCapabilityAdapter } from './infrastructure/available-live-stream-capability.adapter';
import { FeatureLiveStreamCapabilityAdapter } from './infrastructure/feature-live-stream-capability.adapter';
import { FsLiveStreamLeaseAdapter } from './infrastructure/fs-live-stream-lease.adapter';
import { FsLocalStorageAdapter } from './infrastructure/fs-local-storage.adapter';
import { FsMediaFileAdapter } from './infrastructure/fs-media-file.adapter';
import { FsCompletedMotionVideoAdapter } from './infrastructure/fs-completed-motion-video.adapter';
import {
  completedMotionRecoveryOptionsFromConfig,
} from './infrastructure/completed-motion-recovery-options.adapter';
import { InMemoryLiveStreamGatewayAdapter } from './infrastructure/in-memory-live-stream-gateway.adapter';
import { InMemoryLiveStreamLeaseAdapter } from './infrastructure/in-memory-live-stream-lease.adapter';
import { InMemoryMediaRepository } from './infrastructure/in-memory-media.repository';
import { InMemoryMonotonicClockAdapter } from './infrastructure/in-memory-monotonic-clock.adapter';
import { MotionDaemonAdapter } from './infrastructure/motion-daemon.adapter';
import { QuickTunnelLiveStreamAdapter } from './infrastructure/quick-tunnel-live-stream.adapter';
import { StubLocalStorageAdapter } from './infrastructure/stub-local-storage.adapter';
import { StubMediaFileAdapter } from './infrastructure/stub-media-file.adapter';
import { StubMotionAlertAdapter } from './infrastructure/stub-motion-alert.adapter';
import { StubMotionControlAdapter } from './infrastructure/stub-motion-control.adapter';
import { StubRetentionPruneAdapter } from './infrastructure/stub-retention-prune.adapter';
import { StubSnapshotAdapter } from './infrastructure/stub-snapshot.adapter';
import { SystemMonotonicClockAdapter } from './infrastructure/system-monotonic-clock.adapter';
import { MotionHooksController } from './interfaces/motion-hooks.controller';
import { LIVE_VIEW_SETTINGS_STORE, type LiveViewSettingsStorePort } from './domain/ports/live-view-settings-store.port';
import { LIVE_VIEW_SETTINGS_JOB_REPOSITORY } from './domain/ports/live-view-settings-job-repository.port';
import { LIVE_VIEW_POLICY_REQUEST } from './domain/ports/live-view-policy-request.port';
import { LIVE_VIEW_POLICY_RESULT } from './domain/ports/live-view-policy-result.port';
import { LIVE_VIEW_POLICY_ACKNOWLEDGEMENT } from './domain/ports/live-view-policy-acknowledgement.port';
import { LIVE_VIEW_POLICY_CONTROLLER } from './domain/ports/live-view-policy-controller.port';
import { LIVE_VIEW_MIGRATION_ATTENTION } from './domain/ports/live-view-migration-attention.port';
import { PRIVATE_SUBNET_DETECTOR } from './domain/ports/private-subnet-detector.port';
import { FsLiveViewSettingsAdapter } from './infrastructure/fs-live-view-settings.adapter';
import { InMemoryLiveViewSettingsAdapter } from './infrastructure/in-memory-live-view-settings.adapter';
import { DrizzleLiveViewSettingsJobRepository } from './infrastructure/drizzle-live-view-settings-job.repository';
import { InMemoryLiveViewSettingsJobRepository } from './infrastructure/in-memory-live-view-settings-job.repository';
import { InMemoryLiveViewPolicyAdapter } from './infrastructure/in-memory-live-view-policy.adapter';
import { FsLiveViewPolicyRequestAdapter } from './infrastructure/fs-live-view-policy-request.adapter';
import { FsLiveViewPolicyResultAdapter } from './infrastructure/fs-live-view-policy-result.adapter';
import { FsLiveViewPolicyAcknowledgementAdapter } from './infrastructure/fs-live-view-policy-acknowledgement.adapter';
import { SystemdLiveViewPolicyControllerAdapter } from './infrastructure/systemd-live-view-policy-controller.adapter';
import { FsLiveViewMigrationAttentionAdapter } from './infrastructure/fs-live-view-migration-attention.adapter';
import { OsPrivateSubnetDetectorAdapter } from './infrastructure/os-private-subnet-detector.adapter';
import { GetLiveViewSettingsUseCase } from './application/get-live-view-settings.use-case';
import { ListPrivateSubnetSuggestionsUseCase } from './application/list-private-subnet-suggestions.use-case';
import { ApplyLiveViewSettingsUseCase } from './application/apply-live-view-settings.use-case';
import { ReconcileLiveViewSettingsJobUseCase, RECONCILE_LIVE_VIEW_SETTINGS_JOB_OPTIONS } from './application/reconcile-live-view-settings-job.use-case';
import { LiveViewRestartActivationService } from './application/live-view-restart-activation.service';
import { LiveViewSettingsRecoveryService } from './application/live-view-settings-recovery.service';
import { LiveViewReadinessBarrierService } from './application/live-view-readiness-barrier.service';
import { LiveViewSettingsOutcomeRegistryService } from './application/live-view-settings-outcome-registry.service';
import { LiveViewPolicyCoordinatorService } from './application/live-view-policy-coordinator.service';
import { ReconcileRtspPolicyUseCase } from './application/reconcile-rtsp-policy.use-case';
import { PROCESS_RESTARTER } from '../system/domain/ports/process-restarter.port';

export type CameraMode = 'real' | 'stub';

/**
 * Resolve adapter selection (specs 14, 20). `real` shells out to
 * systemctl/ffmpeg/du; `stub` keeps everything in-process for dev
 * and CI. Defaults to `real` on Linux, `stub` elsewhere or when forced.
 */
function resolveCameraMode(): CameraMode {
  if (process.env.CAMERA_MODE === 'stub') return 'stub';
  if (process.env.CAMERA_MODE === 'real') return 'real';
  return process.platform === 'linux' ? 'real' : 'stub';
}

const mode = resolveCameraMode();
const liveStreamOptions = liveStreamOptionsFromEnv(process.env);
const completedMotionRecoveryOptions = completedMotionRecoveryOptionsFromConfig(
  loadDefaults().archive,
  process.env,
);

function cameraInstallationId(cameraMode: CameraMode): string | null {
  const direct = process.env.HOME_WORKER_INSTALLATION_ID?.trim();
  if (isInstallationId(direct)) return direct;
  try {
    const persisted = readFileSync(
      process.env.HOME_WORKER_INSTALLATION_ID_PATH ?? '/etc/home-worker/installation-id',
      'utf8',
    ).trim();
    if (isInstallationId(persisted)) return persisted;
  } catch {
    // Development and test composition do not install the root-owned state file.
  }
  return cameraMode === 'stub'
    ? '00000000-0000-4000-8000-000000000000'
    : null;
}

function isInstallationId(value: string | undefined): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

/**
 * Camera composition root (specs 14, 20, 21).
 *
 * Real adapters drive the Motion daemon, ffmpeg snapshots, and `du` storage
 * accounting. The Archive context owns Google Drive; Camera crosses that
 * boundary only through registration, verification, and retention ports.
 */
@Module({
  imports: [DatabaseModule, ArchiveModule, EventModule, FeatureModule, SystemModule],
  controllers: [MotionHooksController],
  providers: [
    { provide: CAMERA_MODE, useValue: mode },
    { provide: LIVE_STREAM_OPTIONS, useValue: liveStreamOptions },
    {
      provide: LIVE_VIEW_SETTINGS_STORE,
      useFactory: async (): Promise<LiveViewSettingsStorePort> => {
        const settings = mode === 'stub' ? new InMemoryLiveViewSettingsAdapter() : new FsLiveViewSettingsAdapter();
        await settings.readCommitted().catch(() => undefined);
        return settings;
      },
    },
    { provide: LIVE_VIEW_SETTINGS_JOB_REPOSITORY, useClass: mode === 'stub' ? InMemoryLiveViewSettingsJobRepository : DrizzleLiveViewSettingsJobRepository },
    {
      provide: LIVE_SOURCE_PROBE_OPTIONS,
      useFactory: async (settings: LiveViewSettingsStorePort) => {
        const committed = await settings.readCommitted().catch(() => null);
        return liveSourceProbeOptionsFromEnvironment(process.env, committed?.allowedCameraCidrs ?? []);
      },
      inject: [LIVE_VIEW_SETTINGS_STORE],
    },
    ...(mode === 'stub' ? [{
      provide: InMemoryLiveViewPolicyAdapter,
      useFactory: (settings: InMemoryLiveViewSettingsAdapter) => new InMemoryLiveViewPolicyAdapter(settings),
      inject: [LIVE_VIEW_SETTINGS_STORE],
    }] : []),
    { provide: LIVE_VIEW_POLICY_REQUEST, ...(mode === 'stub' ? { useExisting: InMemoryLiveViewPolicyAdapter } : { useFactory: () => new FsLiveViewPolicyRequestAdapter() }) },
    { provide: LIVE_VIEW_POLICY_RESULT, ...(mode === 'stub' ? { useExisting: InMemoryLiveViewPolicyAdapter } : { useFactory: () => new FsLiveViewPolicyResultAdapter() }) },
    { provide: LIVE_VIEW_POLICY_ACKNOWLEDGEMENT, ...(mode === 'stub' ? { useExisting: InMemoryLiveViewPolicyAdapter } : { useFactory: () => new FsLiveViewPolicyAcknowledgementAdapter() }) },
    { provide: LIVE_VIEW_POLICY_CONTROLLER, ...(mode === 'stub' ? { useExisting: InMemoryLiveViewPolicyAdapter } : { useFactory: () => new SystemdLiveViewPolicyControllerAdapter() }) },
    { provide: LIVE_VIEW_MIGRATION_ATTENTION, useFactory: () => mode === 'stub' ? { read: async () => null } : new FsLiveViewMigrationAttentionAdapter() },
    { provide: PRIVATE_SUBNET_DETECTOR, useFactory: () => mode === 'stub' ? { detect: async () => [] } : new OsPrivateSubnetDetectorAdapter() },
    GetLiveViewSettingsUseCase,
    ListPrivateSubnetSuggestionsUseCase,
    LiveViewPolicyCoordinatorService,
    LiveViewReadinessBarrierService,
    LiveViewSettingsOutcomeRegistryService,
    ReconcileRtspPolicyUseCase,
    { provide: RECONCILE_LIVE_VIEW_SETTINGS_JOB_OPTIONS, useValue: {} },
    {
      provide: LiveViewRestartActivationService,
      useFactory: (...args: ConstructorParameters<typeof LiveViewRestartActivationService>) => new LiveViewRestartActivationService(...args),
      inject: [LIVE_VIEW_SETTINGS_JOB_REPOSITORY, LIVE_VIEW_SETTINGS_STORE, LiveViewStartGate, PROCESS_RESTARTER, CAMERA_CLOCK],
    },
    {
      provide: ReconcileLiveViewSettingsJobUseCase,
      useFactory: (...args: ConstructorParameters<typeof ReconcileLiveViewSettingsJobUseCase>) => new ReconcileLiveViewSettingsJobUseCase(...args),
      inject: [LIVE_VIEW_SETTINGS_JOB_REPOSITORY, LIVE_VIEW_SETTINGS_STORE, FEATURE_QUERY, LiveViewStartGate, LiveStreamSessionService, LiveViewPolicyCoordinatorService, LIVE_VIEW_POLICY_REQUEST, LIVE_VIEW_POLICY_CONTROLLER, LIVE_VIEW_POLICY_RESULT, LIVE_VIEW_POLICY_ACKNOWLEDGEMENT, PROCESS_RESTARTER, LIVE_STREAM_CAPABILITY, CAMERA_CLOCK, RECONCILE_LIVE_VIEW_SETTINGS_JOB_OPTIONS, LiveViewRestartActivationService, LiveViewSettingsOutcomeRegistryService],
    },
    { provide: ApplyLiveViewSettingsUseCase, useFactory: (reconcile: ReconcileLiveViewSettingsJobUseCase) => new ApplyLiveViewSettingsUseCase(reconcile), inject: [ReconcileLiveViewSettingsJobUseCase] },
    {
      provide: LiveViewSettingsRecoveryService,
      useFactory: (...args: ConstructorParameters<typeof LiveViewSettingsRecoveryService>) => new LiveViewSettingsRecoveryService(...args),
      inject: [LIVE_VIEW_SETTINGS_JOB_REPOSITORY, ReconcileLiveViewSettingsJobUseCase, LIVE_VIEW_SETTINGS_STORE, LiveViewStartGate, RtspSourceStartGate, LiveViewReadinessBarrierService, LiveViewSettingsOutcomeRegistryService, FEATURE_QUERY, ReconcileRtspPolicyUseCase],
    },
    mode === 'stub' ? InMemoryMediaRepository : DrizzleMediaRepository,
    {
      provide: MEDIA_REPOSITORY,
      useExisting: mode === 'stub' ? InMemoryMediaRepository : DrizzleMediaRepository,
    },
    {
      provide: MEDIA_WRITER,
      useExisting: mode === 'stub' ? InMemoryMediaRepository : DrizzleMediaRepository,
    },
    {
      provide: COMPLETED_MOTION_VIDEO,
      useFactory: (monotonic: MonotonicClockPort): CompletedMotionVideoPort =>
        new FsCompletedMotionVideoAdapter({
          installationId: cameraInstallationId(mode) ?? undefined,
          monotonicClock: monotonic,
        }),
      inject: [MONOTONIC_CLOCK],
    },
    {
      provide: RegisterCompletedMotionVideosUseCase,
      useFactory: (
        media: MediaRepositoryPort,
        writer: import('./domain/ports/media-writer.port').MediaWriterPort,
        completedVideos: CompletedMotionVideoPort,
        archive: ArchiveRegistrationPort,
        archiveLookup: ArchiveRegistrationLookupPort,
        monotonic: MonotonicClockPort,
      ) => new RegisterCompletedMotionVideosUseCase(
        media,
        completedVideos,
        archive,
        archiveLookup,
        monotonic,
        cameraInstallationId(mode),
        writer,
      ),
      inject: [
        MEDIA_REPOSITORY,
        MEDIA_WRITER,
        COMPLETED_MOTION_VIDEO,
        ARCHIVE_REGISTRATION,
        ARCHIVE_REGISTRATION_LOOKUP,
        MONOTONIC_CLOCK,
      ],
    },
    {
      provide: CompletedMotionVideoRecoveryScheduler,
      useFactory: (
        cameraMode: CameraMode,
        registration: RegisterCompletedMotionVideosUseCase,
        completedVideos: CompletedMotionVideoPort,
        progress: ArchiveRuntimeSignalPort,
        alerts: AdminAlertPort,
      ) => new CompletedMotionVideoRecoveryScheduler(
        cameraMode,
        registration,
        completedVideos,
        completedMotionRecoveryOptions,
        progress,
        undefined, // clock: the scheduler keeps its own system clock
        alerts,
      ),
      inject: [
        CAMERA_MODE,
        RegisterCompletedMotionVideosUseCase,
        COMPLETED_MOTION_VIDEO,
        ARCHIVE_RUNTIME_SIGNAL,
        ADMIN_ALERT,
      ],
    },
    {
      provide: 'ARCHIVE_CAMERA_SCHEDULER_HOOK_REGISTRATION',
      useFactory: (
        hooks: ArchiveSchedulerHooksService,
        recovery: CompletedMotionVideoRecoveryScheduler,
        cleanup: CleanupCoordinatorService,
      ) => {
        hooks.registerCamera({
          reconcileMotion: async (signal) => recovery.reconcile(signal),
          cleanupLocal: async (signal) => {
            await cleanup.runCleanup('local', undefined, signal);
          },
        });
        return hooks;
      },
      inject: [
        ArchiveSchedulerHooksService,
        CompletedMotionVideoRecoveryScheduler,
        CleanupCoordinatorService,
      ],
    },
    {
      provide: MOTION_CONTROL,
      useClass: mode === 'stub' ? StubMotionControlAdapter : MotionDaemonAdapter,
    },
    {
      provide: SNAPSHOT,
      useClass: mode === 'stub' ? StubSnapshotAdapter : FfmpegSnapshotAdapter,
    },
    {
      provide: MEDIA_FILE,
      useClass: mode === 'stub' ? StubMediaFileAdapter : FsMediaFileAdapter,
    },
    {
      provide: LOCAL_STORAGE,
      useClass: mode === 'stub' ? StubLocalStorageAdapter : FsLocalStorageAdapter,
    },
    {
      provide: RETENTION_PRUNE,
      useClass: mode === 'stub' ? StubRetentionPruneAdapter : DrizzleRetentionPruneAdapter,
    },
    {
      provide: MOTION_ALERT,
      useClass: mode === 'stub' ? StubMotionAlertAdapter : EventsMotionAlertAdapter,
    },
    AdminAlertService,
    { provide: ADMIN_ALERT, useExisting: AdminAlertService },
    CameraSourceAuthorizationRegistry,
    {
      provide: CAMERA_SOURCE_AUTHORIZATION,
      useExisting: CameraSourceAuthorizationRegistry,
    },
    {
      provide: LIVE_STREAM_CAPABILITY,
      ...(mode === 'stub'
        ? {
            useFactory: (): LiveStreamCapabilityPort => new AvailableLiveStreamCapabilityAdapter(true),
          }
        : {
            useFactory: (
              features: FeatureQueryPort,
            ): LiveStreamCapabilityPort =>
              new FeatureLiveStreamCapabilityAdapter(features, true),
            inject: [FEATURE_QUERY],
          }),
    },
    {
      provide: LIVE_STREAM_GATEWAY,
      useFactory: (options: LiveStreamOptions, rtspRuntime: RtspStreamRuntimePort): LiveStreamGatewayPort =>
        mode === 'stub'
          ? new InMemoryLiveStreamGatewayAdapter()
          : new QuickTunnelLiveStreamAdapter({
              startupTimeoutMs: options.startTimeoutMs,
              maxViewers: options.maxViewers,
              rtspRuntime,
            }),
      inject: [LIVE_STREAM_OPTIONS, RTSP_STREAM_RUNTIME],
    },
    {
      provide: LIVE_STREAM_LEASE,
      useFactory: (options: LiveStreamOptions): LiveStreamLeasePort =>
        mode === 'stub'
          ? new InMemoryLiveStreamLeaseAdapter()
          : new FsLiveStreamLeaseAdapter(options.runtimeDirectory),
      inject: [LIVE_STREAM_OPTIONS],
    },
    {
      provide: MONOTONIC_CLOCK,
      useClass: mode === 'stub'
        ? InMemoryMonotonicClockAdapter
        : SystemMonotonicClockAdapter,
    },
    {
      provide: LIVE_SOURCE_CREDENTIAL,
      useFactory: (): LiveSourceCredentialPort =>
        liveSourceCredentialFromEnvironment(process.env),
    },
    {
      provide: LIVE_SOURCE_REPOSITORY,
      useFactory: (
        credentials: LiveSourceCredentialPort,
        drizzleRepository: DrizzleLiveSourceRepository,
        media: MediaRepositoryPort,
      ): LiveSourceRepositoryPort =>
        mode === 'stub'
          ? new InMemoryLiveSourceRepository(credentials, async (cameraId) =>
              (await media.listCameras()).find((camera) => camera.id === cameraId)
                ?.name ?? cameraId,
            )
          : drizzleRepository,
      inject: [LIVE_SOURCE_CREDENTIAL, DrizzleLiveSourceRepository, MEDIA_REPOSITORY],
    },
    DrizzleLiveSourceRepository,
    { provide: CAMERA_ID_GENERATOR, useClass: CryptoCameraIdGeneratorAdapter },
    { provide: CAMERA_CLOCK, useClass: SystemCameraClockAdapter },
    {
      provide: RTSP_SOURCE_CONFIGURATION,
      useFactory: async (
        media: MediaRepositoryPort,
        sources: LiveSourceRepositoryPort,
        db: AppDatabase,
      ): Promise<RtspSourceConfigurationPort> => {
        // `backfillNameKeys` has to precede the first camera mutation, and this
        // port is the only thing that mutates camera rows. Awaiting it inside
        // the factory means no consumer can hold the port before it has run:
        // Nest settles every provider factory before any `onModuleInit`, well
        // before the bot gateway's `onApplicationBootstrap` and `app.listen()`
        // open the two paths a mutation can arrive on.
        try {
          await media.backfillNameKeys();
        } catch (error) {
          // Legacy names that already collide leave those rows keyless rather
          // than taking Telegram and the sensors down with the camera context.
          // The unique index still guards every keyed row, and
          // `findCameraByName` still canonicalizes the keyless ones.
          new Logger('CameraModule').error(
            `Camera name keys were not backfilled: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (mode !== 'stub') return new DrizzleRtspSourceConfigurationAdapter(db);
        // Share the stub repositories' rows rather than keeping a fourth,
        // private camera store: a camera created through this port has to be
        // visible to `listCameras`/`findCameraByName`/`listRedacted`, and name
        // uniqueness has to be decided against the rows the rest of the app
        // sees. Mirrors the resolver the sibling stub repository takes above.
        if (
          !(media instanceof InMemoryMediaRepository) ||
          !(sources instanceof InMemoryLiveSourceRepository)
        ) {
          throw new Error(
            'stub camera composition must use the in-memory repositories',
          );
        }
        return new InMemoryRtspSourceConfigurationAdapter(media, sources);
      },
      inject: [MEDIA_REPOSITORY, LIVE_SOURCE_REPOSITORY, DB],
    },
    {
      provide: STREAM_EGRESS,
      useFactory: (): StreamEgressPort => mode === 'stub'
        ? new UnavailableStreamEgressAdapter()
        : new NftStreamEgressAdapter(new UnixLocalStreamHelperClient()),
    },
    {
      provide: STREAM_SANDBOX,
      useFactory: (probe: FfmpegLiveSourceProbeOptions | null): StreamSandboxPort => {
        return mode === 'stub' || !probe
          ? new UnavailableStreamSandboxAdapter()
          : new SystemdFfmpegStreamAdapter({
            configDirectory: '/run/home-worker/live-stream-config',
            outputDirectory: '/run/home-worker/live-stream-output',
            startupTimeoutMs: liveStreamOptions.startTimeoutMs,
            udpPortFirst: probe.udpPortFirst,
            udpPortLast: probe.udpPortLast,
            caFile: probe.caFile,
          });
      },
      inject: [LIVE_SOURCE_PROBE_OPTIONS],
    },
    {
      provide: RTSP_RUNTIME_COORDINATOR,
      useFactory: (egress: StreamEgressPort, sandbox: StreamSandboxPort, options: FfmpegLiveSourceProbeOptions | null): RtspRuntimeCoordinatorPort => {
        return options
          ? new FfmpegLiveSourceProbeAdapter(
              egress,
              options,
              mode === 'real' ? { sandbox } : {},
            )
          : new UnavailableRtspRuntimeCoordinatorAdapter();
      },
      inject: [STREAM_EGRESS, STREAM_SANDBOX, LIVE_SOURCE_PROBE_OPTIONS],
    },
    { provide: LIVE_SOURCE_PROBE, useExisting: RTSP_RUNTIME_COORDINATOR },
    {
      // Credential-free status projection only. It short-circuits to `blocked`
      // when the policy carries no network, so a stub or policy-less host does
      // no DNS at all.
      provide: LIVE_SOURCE_POLICY_EVALUATOR,
      useFactory: () => new SystemLiveSourcePolicyEvaluatorAdapter(),
    },
    {
      provide: RTSP_STREAM_RUNTIME,
      useFactory: (
        sources: LiveSourceRepositoryPort,
        coordinator: RtspRuntimeCoordinatorPort,
        options: FfmpegLiveSourceProbeOptions | null,
      ): RtspStreamRuntimePort => mode === 'real' && options
        ? new RestrictedRtspStreamRuntimeAdapter(sources, coordinator)
        : new UnavailableRtspStreamRuntimeAdapter(),
      inject: [LIVE_SOURCE_REPOSITORY, RTSP_RUNTIME_COORDINATOR, LIVE_SOURCE_PROBE_OPTIONS],
    },
    LiveStreamMessageCleanupService,
    {
      provide: LIVE_STREAM_MESSAGE_CLEANUP,
      useExisting: LiveStreamMessageCleanupService,
    },
    LiveStreamSourceResolverService,
    LiveViewStartGate,
    RtspSourceStartGate,
    {
      provide: LiveStreamSessionService,
      useFactory: (
        gateway: LiveStreamGatewayPort,
        lease: LiveStreamLeasePort,
        clock: MonotonicClockPort,
        alerts: AdminAlertService,
        messageCleanup: LiveStreamMessageCleanupPort,
        options: LiveStreamOptions,
        liveViewStartGate: LiveViewStartGate,
        sourceStartGate: RtspSourceStartGate,
        availability: FeatureAvailabilityPort,
      ) => new LiveStreamSessionService(
        gateway,
        lease,
        clock,
        alerts,
        messageCleanup,
        options.durationMs,
        options.startTimeoutMs,
        options.maxViewers,
        liveViewStartGate,
        sourceStartGate,
        availability,
      ),
      inject: [
        LIVE_STREAM_GATEWAY,
        LIVE_STREAM_LEASE,
        MONOTONIC_CLOCK,
        ADMIN_ALERT,
        LIVE_STREAM_MESSAGE_CLEANUP,
        LIVE_STREAM_OPTIONS,
        LiveViewStartGate,
        RtspSourceStartGate,
        FEATURE_AVAILABILITY,
      ],
    },
    {
      provide: FeatureCameraRuntimeLifecycleService,
      useFactory: (...args: ConstructorParameters<typeof FeatureCameraRuntimeLifecycleService>) => new FeatureCameraRuntimeLifecycleService(...args),
      inject: [MotionWatcherService, MOTION_CONTROL, RtspSourceStartGate, LIVE_SOURCE_SESSION_CONTROL, LIVE_VIEW_SETTINGS_JOB_REPOSITORY, LiveViewPolicyCoordinatorService, ReconcileRtspPolicyUseCase, LIVE_VIEW_SETTINGS_STORE],
    },
    {
      provide: 'FEATURE_CAMERA_RUNTIME_LIFECYCLE_REGISTRATION',
      useFactory: (
        lifecycle: FeatureRuntimeLifecycleRegistryPort,
        camera: FeatureCameraRuntimeLifecycleService,
      ) => {
        lifecycle.register('motion', camera.motion);
        lifecycle.register('rtsp', camera.rtsp);
        return camera;
      },
      inject: [FEATURE_RUNTIME_LIFECYCLE, FeatureCameraRuntimeLifecycleService],
    },
    {
      provide: LIVE_SOURCE_SESSION_CONTROL,
      useFactory: (sessions: LiveStreamSessionService) =>
        new LiveStreamSessionControlAdapter(sessions),
      inject: [LiveStreamSessionService],
    },
    RtspSourceMutationService,
    CreateRtspCameraUseCase,
    AttachRtspSourceUseCase,
    ReplaceRtspSourceUseCase,
    TestRtspSourceUseCase,
    RemoveRtspSourceUseCase,
    ConfigureLiveSourceUseCase,
    LiveSourceCredentialRotationCoordinator,
    ListLiveSourcesUseCase,
    GetRtspSourceOverviewUseCase,
    {
      provide: OpenLiveStreamUseCase,
      useFactory: (...args: ConstructorParameters<typeof OpenLiveStreamUseCase>) => new OpenLiveStreamUseCase(...args),
      inject: [LiveStreamSourceResolverService, LiveStreamSessionService, LIVE_STREAM_CAPABILITY, LiveViewStartGate, RtspSourceStartGate, FEATURE_AVAILABILITY, LiveViewReadinessBarrierService],
    },
    StopLiveStreamUseCase,
    GetSnapshotUseCase,
    BrowseMotionEventsUseCase,
    ListMotionEventsUseCase,
    GetMotionVideoUseCase,
    GetMotionPhotoUseCase,
    EnableMotionUseCase,
    DisableMotionUseCase,
    CameraStatusUseCase,
    ListCamerasUseCase,
    RecordMotionStartUseCase,
    {
      provide: RecordMotionEndUseCase,
      useFactory: (
        media: MediaRepositoryPort,
        writer: import('./domain/ports/media-writer.port').MediaWriterPort,
        availability: FeatureAvailabilityPort,
        registration: RegisterCompletedMotionVideosUseCase,
        recovery: CompletedMotionVideoRecoveryScheduler,
      ) => new RecordMotionEndUseCase(media, writer, availability, registration, recovery),
      inject: [
        MEDIA_REPOSITORY,
        MEDIA_WRITER,
        FEATURE_AVAILABILITY,
        RegisterCompletedMotionVideosUseCase,
        CompletedMotionVideoRecoveryScheduler,
      ],
    },
    RecordSnapshotUseCase,
    MotionWatcherService,
    CleanupLocalStorageUseCase,
    CleanupCoordinatorService,
    TriggerCleanUseCase,
  ],
  exports: [
    LIVE_VIEW_SETTINGS_STORE,
    LIVE_VIEW_SETTINGS_JOB_REPOSITORY,
    LIVE_STREAM_CAPABILITY,
    GetLiveViewSettingsUseCase,
    ListPrivateSubnetSuggestionsUseCase,
    ApplyLiveViewSettingsUseCase,
    LiveViewRestartActivationService,
    LiveViewSettingsOutcomeRegistryService,
    MEDIA_REPOSITORY,
    LIVE_SOURCE_REPOSITORY,
    CreateRtspCameraUseCase,
    AttachRtspSourceUseCase,
    ReplaceRtspSourceUseCase,
    TestRtspSourceUseCase,
    RemoveRtspSourceUseCase,
    ConfigureLiveSourceUseCase,
    ListLiveSourcesUseCase,
    GetRtspSourceOverviewUseCase,
    GetSnapshotUseCase,
    BrowseMotionEventsUseCase,
    ListMotionEventsUseCase,
    GetMotionVideoUseCase,
    GetMotionPhotoUseCase,
    EnableMotionUseCase,
    DisableMotionUseCase,
    CameraStatusUseCase,
    ListCamerasUseCase,
    AdminAlertService,
    CameraSourceAuthorizationRegistry,
    MotionWatcherService,
    CleanupCoordinatorService,
    TriggerCleanUseCase,
    OpenLiveStreamUseCase,
    StopLiveStreamUseCase,
    LiveStreamSessionService,
    LiveStreamMessageCleanupService,
    LiveViewStartGate,
    RtspSourceStartGate,
  ],
})
export class CameraModule {}
