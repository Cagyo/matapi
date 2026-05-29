import { Inject, Injectable, Logger } from '@nestjs/common';
import { posix } from 'node:path';
import { ADMIN_ALERT, AdminAlertPort } from '../domain/ports/admin-alert.port';
import { DRIVE_SYNC, DriveSyncPort } from '../domain/ports/drive-sync.port';
import {
  GDRIVE_SYNC_HEALTH,
  GdriveSyncHealthPort,
} from '../domain/ports/gdrive-sync-health.port';
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
 * path. Only events whose recording finished at least `--min-age` ago are
 * marked, so a file still being copied is never flagged uploaded (and so never
 * eligible for local deletion). Records sync health and alerts admins after
 * five consecutive failures.
 */
@Injectable()
export class UploadMotionUseCase {
  private readonly logger = new Logger(UploadMotionUseCase.name);
  private readonly localDir = process.env.MOTION_LOCAL_DIR ?? '/var/lib/motion';
  private readonly remotePath = process.env.GDRIVE_REMOTE_PATH ?? 'home-security/motion';

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
    @Inject(DRIVE_SYNC) private readonly drive: DriveSyncPort,
    @Inject(GDRIVE_SYNC_HEALTH) private readonly health: GdriveSyncHealthPort,
    @Inject(ADMIN_ALERT) private readonly adminAlert: AdminAlertPort,
  ) {}

  async execute(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - UPLOAD_MIN_AGE_MS);
    const pending = await this.media.findPendingUploads();
    const eligible = pending.filter((e) => e.endedAt !== null && e.endedAt <= cutoff);
    if (eligible.length === 0) return;

    try {
      await this.drive.copyMotionFiles();
    } catch (err) {
      await this.handleFailure(err as Error);
      return;
    }

    for (const event of eligible) {
      if (!event.videoPath) continue;
      await this.writer.markUploaded(event.id, this.remotePathFor(event.videoPath));
    }
    this.health.recordSuccess(now);
    this.logger.log(`Uploaded ${eligible.length} motion file(s) to Drive`);
  }

  private async handleFailure(err: Error): Promise<void> {
    this.health.recordFailure(err.message);
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
