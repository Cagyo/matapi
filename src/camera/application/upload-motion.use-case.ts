import { Inject, Injectable, Logger } from '@nestjs/common';
import { posix } from 'node:path';
import { MotionEvent } from '../domain/motion-event.entity';
import { ADMIN_ALERT, AdminAlertPort } from '../domain/ports/admin-alert.port';
import { DRIVE_SYNC, DriveSyncPort } from '../domain/ports/drive-sync.port';
import {
  GDRIVE_SYNC_HEALTH,
  GdriveSyncHealthPort,
} from '../domain/ports/gdrive-sync-health.port';
import { MEDIA_FILE, MediaFilePort } from '../domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';

/** Files newer than this are skipped (matches the rclone `--min-age 1m`). */
const UPLOAD_MIN_AGE_MS = 60_000;
/** Consecutive failures before alerting admins (spec 21). */
const FAILURE_ALERT_THRESHOLD = 5;

/**
 * Drive upload loop (spec 21). Bulk-copies the local Motion tree to Drive with
 * `rclone copy` (additive), then marks the uploaded events with their remote
 * path. An event is only marked when its recording finished AND its video's
 * (and any snapshot's) mtime is at least `--min-age` old - matching exactly
 * what rclone's mtime filter transferred - so a skipped or still-fresh file
 * is never flagged uploaded (and so never eligible for local deletion).
 * Records sync health and alerts admins after five consecutive failures.
 */
@Injectable()
export class UploadMotionUseCase {
  private readonly logger = new Logger(UploadMotionUseCase.name);
  private readonly localDir = process.env.MOTION_LOCAL_DIR ?? '/home/pi/motion/videos';
  private readonly remotePath = process.env.GDRIVE_REMOTE_PATH ?? 'home-security/motion';

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
    @Inject(DRIVE_SYNC) private readonly drive: DriveSyncPort,
    @Inject(GDRIVE_SYNC_HEALTH) private readonly health: GdriveSyncHealthPort,
    @Inject(ADMIN_ALERT) private readonly adminAlert: AdminAlertPort,
    @Inject(MEDIA_FILE) private readonly files: MediaFilePort,
  ) {}

  async execute(): Promise<void> {
    const now = new Date();
    const cutoffMs = now.getTime() - UPLOAD_MIN_AGE_MS;
    const pending = await this.media.findPendingUploads();
    const eligible: MotionEvent[] = [];
    for (const event of pending) {
      if (!event.endedAt || event.endedAt.getTime() > cutoffMs) continue;
      if (!event.videoPath) continue;
      const mtime = await this.files.mtimeMs(event.videoPath);
      if (mtime === null) {
        this.logger.warn(
          `Pending upload ${event.id}: local file missing (${event.videoPath})`,
        );
        continue;
      }
      // rclone filters on mtime; a file too fresh for --min-age is skipped by
      // the copy and must not be marked uploaded this cycle.
      if (mtime > cutoffMs) continue;
      if (event.snapshotPath) {
        const snapMtime = await this.files.mtimeMs(event.snapshotPath);
        // A still-fresh snapshot is skipped by --min-age exactly like a fresh
        // video; marking now would let cleanup delete it un-uploaded. A
        // missing snapshot blocks nothing - there is no file left to lose.
        if (snapMtime !== null && snapMtime > cutoffMs) continue;
      }
      eligible.push(event);
    }
    if (eligible.length === 0) return;

    try {
      await this.drive.copyMotionFiles();
    } catch (err) {
      await this.handleFailure(err as Error);
      return;
    }

    for (const event of eligible) {
      await this.writer.markUploaded(event.id, this.remotePathFor(event.videoPath!));
    }
    await this.health.recordSuccess(now);
    this.logger.log(`Uploaded ${eligible.length} motion file(s) to Drive`);
  }

  private async handleFailure(err: Error): Promise<void> {
    await this.health.recordFailure(err.message);
    const { consecutiveFailures } = this.health.snapshot();
    this.logger.warn(
      `Drive upload failed (${consecutiveFailures} in a row): ${err.message}`,
    );
    if (consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
      await this.adminAlert.alert('gdrive-sync-failing', err.message);
    }
  }

  /** Map a local file path to its additive Drive path under the remote root. */
  private remotePathFor(localPath: string): string {
    const rel = posix.relative(this.localDir, localPath);
    const suffix = rel && !rel.startsWith('..') ? rel : posix.basename(localPath);
    return posix.join(this.remotePath, suffix);
  }
}
