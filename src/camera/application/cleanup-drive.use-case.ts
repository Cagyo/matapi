import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import { DRIVE_STATUS, DriveStatusPort } from '../domain/ports/drive-status.port';
import { DRIVE_SYNC, DriveSyncPort } from '../domain/ports/drive-sync.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_PERCENT = 80;
const DEFAULT_MIN_AGE_DAYS = 30;

/**
 * Drive-side cleanup loop (spec 21). When the Drive quota reaches
 * `GDRIVE_CLEANUP_PERCENT` (or configured `auto_clean_threshold`), deletes
 * motion files older than the minimum retention (`GDRIVE_CLEANUP_MIN_AGE_DAYS`,
 * default 30) and clears the `gdriveFileId` of the now-removed events.
 */
@Injectable()
export class CleanupDriveUseCase {
  private readonly logger = new Logger(CleanupDriveUseCase.name);

  constructor(
    @Inject(DRIVE_STATUS) private readonly status: DriveStatusPort,
    @Inject(DRIVE_SYNC) private readonly drive: DriveSyncPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
  ) {}

  async execute(customThreshold?: number): Promise<{ thresholdUsed: number }> {
    const threshold = await this.resolveThreshold(customThreshold);
    const quota = await this.status.about();
    if (quota.totalBytes <= 0) return { thresholdUsed: threshold };

    const usedPercent = (quota.usedBytes / quota.totalBytes) * 100;
    if (usedPercent < threshold) return { thresholdUsed: threshold };

    const minAgeDays = this.minAgeDays();
    this.logger.warn(
      `Drive at ${Math.round(usedPercent)}% — pruning files older than ${minAgeDays}d`,
    );
    await this.drive.pruneMotionFiles(minAgeDays);
    const cutoff = new Date(Date.now() - minAgeDays * DAY_MS);
    const cleared = await this.writer.clearGdriveForEventsOlderThan(cutoff);
    this.logger.log(`Cleared Drive reference on ${cleared} event(s)`);
    return { thresholdUsed: threshold };
  }

  private async resolveThreshold(custom?: number): Promise<number> {
    if (custom !== undefined && Number.isFinite(custom) && custom >= 10 && custom <= 99) {
      return Math.trunc(custom);
    }
    const rawMeta = await this.meta.get('auto_clean_threshold');
    if (rawMeta !== null) {
      const val = Number(rawMeta);
      if (Number.isFinite(val) && val >= 10 && val <= 99) {
        return Math.trunc(val);
      }
    }
    const envVal = Number(process.env.GDRIVE_CLEANUP_PERCENT);
    if (Number.isFinite(envVal) && envVal >= 10 && envVal <= 99) {
      return Math.trunc(envVal);
    }
    return DEFAULT_CLEANUP_PERCENT;
  }

  private minAgeDays(): number {
    const raw = Number(process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MIN_AGE_DAYS;
  }
}
