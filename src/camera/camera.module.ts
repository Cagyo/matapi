import { Module } from '@nestjs/common';
import { CameraStatusUseCase } from './application/camera-status.use-case';
import { DisableMotionUseCase } from './application/disable-motion.use-case';
import { EnableMotionUseCase } from './application/enable-motion.use-case';
import { GdriveStatusUseCase } from './application/gdrive-status.use-case';
import { GetMotionPhotoUseCase } from './application/get-motion-photo.use-case';
import { GetMotionVideoUseCase } from './application/get-motion-video.use-case';
import { GetSnapshotUseCase } from './application/get-snapshot.use-case';
import { ListCamerasUseCase } from './application/list-cameras.use-case';
import { ListMotionEventsUseCase } from './application/list-motion-events.use-case';
import { DRIVE_STATUS } from './domain/ports/drive-status.port';
import { GDRIVE_SYNC_HEALTH } from './domain/ports/gdrive-sync-health.port';
import { MEDIA_FILE } from './domain/ports/media-file.port';
import { MEDIA_REPOSITORY } from './domain/ports/media-repository.port';
import { MOTION_CONTROL } from './domain/ports/motion-control.port';
import { SNAPSHOT } from './domain/ports/snapshot.port';
import { DrizzleMediaRepository } from './infrastructure/drizzle-media.repository';
import { FfmpegSnapshotAdapter } from './infrastructure/ffmpeg-snapshot.adapter';
import { FsMediaFileAdapter } from './infrastructure/fs-media-file.adapter';
import { InMemoryGdriveSyncHealth } from './infrastructure/in-memory-gdrive-sync-health';
import { InMemoryMediaRepository } from './infrastructure/in-memory-media.repository';
import { MotionDaemonAdapter } from './infrastructure/motion-daemon.adapter';
import { RcloneDriveStatusAdapter } from './infrastructure/rclone-drive-status.adapter';
import { StubDriveStatusAdapter } from './infrastructure/stub-drive-status.adapter';
import { StubMediaFileAdapter } from './infrastructure/stub-media-file.adapter';
import { StubMotionControlAdapter } from './infrastructure/stub-motion-control.adapter';
import { StubSnapshotAdapter } from './infrastructure/stub-snapshot.adapter';
import { CleanupService } from './cleanup.service';
import { UploadService } from './upload.service';

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

/**
 * Camera composition root (specs 14, 15, 20, 21).
 *
 * Real adapters drive the Motion daemon, ffmpeg snapshots, rclone Drive
 * status and `du` storage accounting. Stub adapters provide the same ports
 * in memory so the `/camera` and `/gdrive` commands run on a dev box
 * without those binaries installed.
 */
@Module({
  providers: [
    {
      provide: MEDIA_REPOSITORY,
      useClass: mode === 'stub' ? InMemoryMediaRepository : DrizzleMediaRepository,
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
    { provide: GDRIVE_SYNC_HEALTH, useClass: InMemoryGdriveSyncHealth },
    GetSnapshotUseCase,
    ListMotionEventsUseCase,
    GetMotionVideoUseCase,
    GetMotionPhotoUseCase,
    EnableMotionUseCase,
    DisableMotionUseCase,
    CameraStatusUseCase,
    GdriveStatusUseCase,
    ListCamerasUseCase,
    UploadService,
    CleanupService,
  ],
  exports: [
    GetSnapshotUseCase,
    ListMotionEventsUseCase,
    GetMotionVideoUseCase,
    GetMotionPhotoUseCase,
    EnableMotionUseCase,
    DisableMotionUseCase,
    CameraStatusUseCase,
    GdriveStatusUseCase,
    ListCamerasUseCase,
    GDRIVE_SYNC_HEALTH,
  ],
})
export class CameraModule {}
