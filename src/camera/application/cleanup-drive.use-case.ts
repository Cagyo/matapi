import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIVE_STATUS, DriveStatusPort } from '../domain/ports/drive-status.port';
import { DRIVE_SYNC, DriveSyncPort } from '../domain/ports/drive-sync.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_PERCENT = 80;
const DEFAULT_MIN_AGE_DAYS = 30;

/**
 * Drive-side cleanup loop (spec 21). When the Drive quota reaches
 * `GDRIVE_CLEANUP_PERCENT`, deletes motion files older than the minimum
 * retention (`GDRIVE_CLEANUP_MIN_AGE_DAYS`, default 30) and clears the
 * `gdriveFileId` of the now-removed events.
 */
@Injectable()
export class CleanupDriveUseCase {
  private readonly logger = new Logger(CleanupDriveUseCase.name);

  constructor(
    @Inject(DRIVE_STATUS) private readonly status: DriveStatusPort,
    @Inject(DRIVE_SYNC) private readonly drive: DriveSyncPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
  ) {}

  async execute(): Promise<void> {
    const quota = await this.status.about();
    if (quota.totalBytes <= 0) return;

    const usedPercent = (quota.usedBytes / quota.totalBytes) * 100;
    const threshold = this.percentEnv('GDRIVE_CLEANUP_PERCENT', DEFAULT_CLEANUP_PERCENT);
    if (usedPercent < threshold) return;

    const minAgeDays = this.minAgeDays();
    this.logger.warn(
      `Drive at ${Math.round(usedPercent)}% — pruning files older than ${minAgeDays}d`,
    );
    await this.drive.pruneMotionFiles(minAgeDays);
    const cutoff = new Date(Date.now() - minAgeDays * DAY_MS);
    const cleared = await this.writer.clearGdriveForEventsOlderThan(cutoff);
    this.logger.log(`Cleared Drive reference on ${cleared} event(s)`);
  }

  private percentEnv(key: string, fallback: number): number {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  private minAgeDays(): number {
    const raw = Number(process.env.GDRIVE_CLEANUP_MIN_AGE_DAYS);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MIN_AGE_DAYS;
  }
}
