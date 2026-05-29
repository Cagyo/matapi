import { Inject, Injectable } from '@nestjs/common';
import {
  DRIVE_STATUS,
  DriveQuota,
  DriveStatusPort,
} from '../domain/ports/drive-status.port';
import {
  GDRIVE_SYNC_HEALTH,
  GdriveSyncHealthPort,
} from '../domain/ports/gdrive-sync-health.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

export interface GdriveStatusResult {
  quota: DriveQuota;
  lastUploadAt: Date | null;
  pendingUploads: number;
  failedUploads: number;
  lastError: string | null;
  cleanupMinAgeDays: number;
}

const DEFAULT_CLEANUP_MIN_AGE_DAYS = 30;

/**
 * `/gdrive status` — spec 15.
 *
 * Composes Drive quota (`rclone about`), upload counters from the media
 * repository, and the in-process sync-health record. Drive-port failures
 * surface as typed domain errors and are mapped in the handler.
 */
@Injectable()
export class GdriveStatusUseCase {
  constructor(
    @Inject(DRIVE_STATUS) private readonly drive: DriveStatusPort,
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(GDRIVE_SYNC_HEALTH) private readonly health: GdriveSyncHealthPort,
  ) {}

  async execute(): Promise<GdriveStatusResult> {
    const quota = await this.drive.about();
    const stats = await this.media.uploadStats();
    const health = this.health.snapshot();

    return {
      quota,
      lastUploadAt: stats.lastUploadAt ?? health.lastSuccessAt,
      pendingUploads: stats.pending,
      failedUploads: health.consecutiveFailures,
      lastError: health.lastError,
      cleanupMinAgeDays: this.cleanupMinAgeDays(),
    };
  }

  private cleanupMinAgeDays(): number {
    const raw = Number(process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLEANUP_MIN_AGE_DAYS;
  }
}
