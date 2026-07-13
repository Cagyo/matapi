import { Module } from '@nestjs/common';
import { EventModule } from '../events/event.module';
import { FeatureModule } from '../features/feature.module';
import {
  FEATURE_QUERY,
  type FeatureQueryPort,
} from '../features/domain/ports/feature-query.port';
import { SystemModule } from '../system/system.module';
import { AdminAlertService } from './application/admin-alert.service';
import { BackupUploadUseCase } from './application/backup-upload.use-case';
import { BrowseMotionEventsUseCase } from './application/browse-motion-events.use-case';
import { CameraStatusUseCase } from './application/camera-status.use-case';
import { CleanupCoordinatorService } from './application/cleanup-coordinator.service';
import { CleanupDriveUseCase } from './application/cleanup-drive.use-case';
import { CleanupLocalStorageUseCase } from './application/cleanup-local-storage.use-case';
import { DisableMotionUseCase } from './application/disable-motion.use-case';
import { DriveSyncScheduler } from './application/drive-sync.scheduler';
import { EnableMotionUseCase } from './application/enable-motion.use-case';
import { GdriveStatusUseCase } from './application/gdrive-status.use-case';
import { GetMotionPhotoUseCase } from './application/get-motion-photo.use-case';
import { GetMotionVideoUseCase } from './application/get-motion-video.use-case';
import { GetSnapshotUseCase } from './application/get-snapshot.use-case';
import { ListCamerasUseCase } from './application/list-cameras.use-case';
import { ConfigureLiveSourceUseCase } from './application/configure-live-source.use-case';
import { ListLiveSourcesUseCase } from './application/list-live-sources.use-case';
import { RemoveLiveSourceUseCase } from './application/remove-live-source.use-case';
import { ListMotionEventsUseCase } from './application/list-motion-events.use-case';
import { LiveStreamMessageCleanupService } from './application/live-stream-message-cleanup.service';
import { LiveStreamSessionService } from './application/live-stream-session.service';
import { LiveSourceCredentialRotationCoordinator } from './application/live-source-credential-rotation-coordinator.service';
import { LiveStreamSourceResolverService } from './application/live-stream-source-resolver.service';
import { MotionWatcherService } from './application/motion-watcher.service';
import { OpenLiveStreamUseCase } from './application/open-live-stream.use-case';
import { RecordMotionEndUseCase } from './application/record-motion-end.use-case';
import { RecordMotionStartUseCase } from './application/record-motion-start.use-case';
import { RecordSnapshotUseCase } from './application/record-snapshot.use-case';
import { StopLiveStreamUseCase } from './application/stop-live-stream.use-case';
import { TriggerCleanUseCase } from './application/trigger-clean.use-case';
import { UploadMotionUseCase } from './application/upload-motion.use-case';
import { UpdateGdriveAuthUseCase } from './application/update-gdrive-auth.use-case';
import {
  CAMERA_MODE,
  LIVE_STREAM_OPTIONS,
  liveStreamOptionsFromEnv,
  type LiveStreamOptions,
} from './camera.tokens';
import { ADMIN_ALERT } from './domain/ports/admin-alert.port';
import { DB_BACKUP } from './domain/ports/db-backup.port';
import { DRIVE_AUTH } from './domain/ports/drive-auth.port';
import { DRIVE_STATUS } from './domain/ports/drive-status.port';
import { DRIVE_SYNC } from './domain/ports/drive-sync.port';
import { GDRIVE_SYNC_HEALTH } from './domain/ports/gdrive-sync-health.port';
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
import { LIVE_SOURCE_SESSION_CONTROL } from './domain/ports/live-source-session-control.port';
import { MEDIA_FILE } from './domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from './domain/ports/media-repository.port';
import { MEDIA_WRITER } from './domain/ports/media-writer.port';
import { MOTION_ALERT } from './domain/ports/motion-alert.port';
import { MOTION_CONTROL } from './domain/ports/motion-control.port';
import {
  MONOTONIC_CLOCK,
  type MonotonicClockPort,
} from './domain/ports/monotonic-clock.port';
import { RETENTION_PRUNE } from './domain/ports/retention-prune.port';
import { SNAPSHOT } from './domain/ports/snapshot.port';
import { STREAM_EGRESS, type StreamEgressPort } from './domain/ports/stream-egress.port';
import { STREAM_SANDBOX, type StreamSandboxPort } from './domain/ports/stream-sandbox.port';
import { RTSP_RUNTIME_COORDINATOR, type RtspRuntimeCoordinatorPort } from './domain/ports/rtsp-runtime-coordinator.port';
import { RTSP_STREAM_RUNTIME, type RtspStreamRuntimePort } from './domain/ports/rtsp-stream-runtime.port';
import { DrizzleMediaRepository } from './infrastructure/drizzle-media.repository';
import { DrizzleLiveSourceRepository } from './infrastructure/drizzle-live-source.repository';
import { InMemoryLiveSourceRepository } from './infrastructure/in-memory-live-source.repository';
import { liveSourceCredentialFromEnvironment } from './infrastructure/aes-gcm-live-source-credential.adapter';
import {
  FfmpegLiveSourceProbeAdapter,
  liveSourceProbeOptionsFromEnvironment,
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
import { InMemoryGdriveSyncHealth } from './infrastructure/in-memory-gdrive-sync-health';
import { InMemoryLiveStreamGatewayAdapter } from './infrastructure/in-memory-live-stream-gateway.adapter';
import { InMemoryLiveStreamLeaseAdapter } from './infrastructure/in-memory-live-stream-lease.adapter';
import { InMemoryMediaRepository } from './infrastructure/in-memory-media.repository';
import { InMemoryMonotonicClockAdapter } from './infrastructure/in-memory-monotonic-clock.adapter';
import { MetaGdriveSyncHealth } from './infrastructure/meta-gdrive-sync-health';
import { MotionDaemonAdapter } from './infrastructure/motion-daemon.adapter';
import { QuickTunnelLiveStreamAdapter } from './infrastructure/quick-tunnel-live-stream.adapter';
import { RcloneDriveAuthAdapter } from './infrastructure/rclone-drive-auth.adapter';
import { RcloneDriveStatusAdapter } from './infrastructure/rclone-drive-status.adapter';
import { RcloneDriveSyncAdapter } from './infrastructure/rclone-drive-sync.adapter';
import { SqliteDbBackupAdapter } from './infrastructure/sqlite-db-backup.adapter';
import { StubDbBackupAdapter } from './infrastructure/stub-db-backup.adapter';
import { StubDriveAuthAdapter } from './infrastructure/stub-drive-auth.adapter';
import { StubDriveStatusAdapter } from './infrastructure/stub-drive-status.adapter';
import { StubDriveSyncAdapter } from './infrastructure/stub-drive-sync.adapter';
import { StubLocalStorageAdapter } from './infrastructure/stub-local-storage.adapter';
import { StubMediaFileAdapter } from './infrastructure/stub-media-file.adapter';
import { StubMotionAlertAdapter } from './infrastructure/stub-motion-alert.adapter';
import { StubMotionControlAdapter } from './infrastructure/stub-motion-control.adapter';
import { StubRetentionPruneAdapter } from './infrastructure/stub-retention-prune.adapter';
import { StubSnapshotAdapter } from './infrastructure/stub-snapshot.adapter';
import { SystemMonotonicClockAdapter } from './infrastructure/system-monotonic-clock.adapter';
import { MotionHooksController } from './interfaces/motion-hooks.controller';

export type CameraMode = 'real' | 'stub';

/**
 * Resolve adapter selection (specs 14, 15). `real` shells out to
 * systemctl/ffmpeg/rclone/du; `stub` keeps everything in-process for dev
 * and CI. Defaults to `real` on Linux, `stub` elsewhere or when forced.
 */
function resolveCameraMode(): CameraMode {
  if (process.env.CAMERA_MODE === 'stub') return 'stub';
  if (process.env.CAMERA_MODE === 'real') return 'real';
  return process.platform === 'linux' ? 'real' : 'stub';
}

const mode = resolveCameraMode();
const liveStreamOptions = liveStreamOptionsFromEnv(process.env);

/**
 * Camera composition root (specs 14, 15, 20, 21).
 *
 * Real adapters drive the Motion daemon, ffmpeg snapshots, rclone Drive
 * status and `du` storage accounting. Stub adapters provide the same ports
 * in memory so the `/camera` and `/gdrive` commands run on a dev box
 * without those binaries installed.
 */
@Module({
  imports: [EventModule, FeatureModule, SystemModule],
  controllers: [MotionHooksController],
  providers: [
    { provide: CAMERA_MODE, useValue: mode },
    { provide: LIVE_STREAM_OPTIONS, useValue: liveStreamOptions },
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
      provide: DRIVE_STATUS,
      useClass: mode === 'stub' ? StubDriveStatusAdapter : RcloneDriveStatusAdapter,
    },
    {
      provide: DRIVE_AUTH,
      useClass: mode === 'stub' ? StubDriveAuthAdapter : RcloneDriveAuthAdapter,
    },
    {
      provide: DRIVE_SYNC,
      useClass: mode === 'stub' ? StubDriveSyncAdapter : RcloneDriveSyncAdapter,
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
      provide: DB_BACKUP,
      useClass: mode === 'stub' ? StubDbBackupAdapter : SqliteDbBackupAdapter,
    },
    {
      provide: MOTION_ALERT,
      useClass: mode === 'stub' ? StubMotionAlertAdapter : EventsMotionAlertAdapter,
    },
    AdminAlertService,
    { provide: ADMIN_ALERT, useExisting: AdminAlertService },
    {
      provide: GDRIVE_SYNC_HEALTH,
      useClass: mode === 'stub' ? InMemoryGdriveSyncHealth : MetaGdriveSyncHealth,
    },
    {
      provide: LIVE_STREAM_CAPABILITY,
      ...(mode === 'stub'
        ? {
            useFactory: (options: LiveStreamOptions): LiveStreamCapabilityPort =>
              new AvailableLiveStreamCapabilityAdapter(options.enabled),
            inject: [LIVE_STREAM_OPTIONS],
          }
        : {
            useFactory: (
              features: FeatureQueryPort,
              options: LiveStreamOptions,
            ): LiveStreamCapabilityPort =>
              new FeatureLiveStreamCapabilityAdapter(features, options.enabled),
            inject: [FEATURE_QUERY, LIVE_STREAM_OPTIONS],
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
    {
      provide: STREAM_EGRESS,
      useFactory: (): StreamEgressPort => mode === 'stub'
        ? new UnavailableStreamEgressAdapter()
        : new NftStreamEgressAdapter(new UnixLocalStreamHelperClient()),
    },
    {
      provide: STREAM_SANDBOX,
      useFactory: (): StreamSandboxPort => {
        const probe = liveSourceProbeOptionsFromEnvironment(process.env);
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
    },
    {
      provide: RTSP_RUNTIME_COORDINATOR,
      useFactory: (egress: StreamEgressPort, sandbox: StreamSandboxPort): RtspRuntimeCoordinatorPort => {
        const options = liveSourceProbeOptionsFromEnvironment(process.env);
        return options
          ? new FfmpegLiveSourceProbeAdapter(
              egress,
              options,
              mode === 'real' ? { sandbox } : {},
            )
          : new UnavailableRtspRuntimeCoordinatorAdapter();
      },
      inject: [STREAM_EGRESS, STREAM_SANDBOX],
    },
    { provide: LIVE_SOURCE_PROBE, useExisting: RTSP_RUNTIME_COORDINATOR },
    {
      provide: RTSP_STREAM_RUNTIME,
      useFactory: (
        sources: LiveSourceRepositoryPort,
        coordinator: RtspRuntimeCoordinatorPort,
      ): RtspStreamRuntimePort => mode === 'real' && liveSourceProbeOptionsFromEnvironment(process.env)
        ? new RestrictedRtspStreamRuntimeAdapter(sources, coordinator)
        : new UnavailableRtspStreamRuntimeAdapter(),
      inject: [LIVE_SOURCE_REPOSITORY, RTSP_RUNTIME_COORDINATOR],
    },
    LiveStreamMessageCleanupService,
    {
      provide: LIVE_STREAM_MESSAGE_CLEANUP,
      useExisting: LiveStreamMessageCleanupService,
    },
    LiveStreamSourceResolverService,
    {
      provide: LiveStreamSessionService,
      useFactory: (
        gateway: LiveStreamGatewayPort,
        lease: LiveStreamLeasePort,
        clock: MonotonicClockPort,
        alerts: AdminAlertService,
        messageCleanup: LiveStreamMessageCleanupPort,
        options: LiveStreamOptions,
      ) => new LiveStreamSessionService(
        gateway,
        lease,
        clock,
        alerts,
        messageCleanup,
        options.durationMs,
        options.startTimeoutMs,
        options.maxViewers,
      ),
      inject: [
        LIVE_STREAM_GATEWAY,
        LIVE_STREAM_LEASE,
        MONOTONIC_CLOCK,
        ADMIN_ALERT,
        LIVE_STREAM_MESSAGE_CLEANUP,
        LIVE_STREAM_OPTIONS,
      ],
    },
    {
      provide: LIVE_SOURCE_SESSION_CONTROL,
      useFactory: (sessions: LiveStreamSessionService) =>
        new LiveStreamSessionControlAdapter(sessions),
      inject: [LiveStreamSessionService],
    },
    ConfigureLiveSourceUseCase,
    LiveSourceCredentialRotationCoordinator,
    ListLiveSourcesUseCase,
    RemoveLiveSourceUseCase,
    OpenLiveStreamUseCase,
    StopLiveStreamUseCase,
    GetSnapshotUseCase,
    BrowseMotionEventsUseCase,
    ListMotionEventsUseCase,
    GetMotionVideoUseCase,
    GetMotionPhotoUseCase,
    EnableMotionUseCase,
    DisableMotionUseCase,
    CameraStatusUseCase,
    GdriveStatusUseCase,
    ListCamerasUseCase,
    RecordMotionStartUseCase,
    RecordMotionEndUseCase,
    RecordSnapshotUseCase,
    MotionWatcherService,
    UploadMotionUseCase,
    CleanupLocalStorageUseCase,
    CleanupDriveUseCase,
    CleanupCoordinatorService,
    TriggerCleanUseCase,
    BackupUploadUseCase,
    DriveSyncScheduler,
    UpdateGdriveAuthUseCase,
  ],
  exports: [
    MEDIA_REPOSITORY,
    LIVE_SOURCE_REPOSITORY,
    ListLiveSourcesUseCase,
    GetSnapshotUseCase,
    BrowseMotionEventsUseCase,
    ListMotionEventsUseCase,
    GetMotionVideoUseCase,
    GetMotionPhotoUseCase,
    EnableMotionUseCase,
    DisableMotionUseCase,
    CameraStatusUseCase,
    GdriveStatusUseCase,
    ListCamerasUseCase,
    AdminAlertService,
    MotionWatcherService,
    GDRIVE_SYNC_HEALTH,
    CleanupCoordinatorService,
    TriggerCleanUseCase,
    UpdateGdriveAuthUseCase,
    OpenLiveStreamUseCase,
    StopLiveStreamUseCase,
    LiveStreamSessionService,
    LiveStreamMessageCleanupService,
  ],
})
export class CameraModule {}
