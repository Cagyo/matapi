import { Inject, Injectable, Logger } from '@nestjs/common';
import { ADMIN_ALERT, AdminAlertPort } from '../domain/ports/admin-alert.port';
import {
  LOCAL_STORAGE,
  LocalStoragePort,
} from '../domain/ports/local-storage.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';
import {
  RETENTION_PRUNE,
  RetentionPrunePort,
} from '../domain/ports/retention-prune.port';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARN_PERCENT = 70;
const DEFAULT_CRITICAL_PERCENT = 80;
const DEFAULT_EMERGENCY_PERCENT = 95;

/**
 * Local storage cleanup loop (spec 21, 23). At `DISK_WARN_PERCENT` it logs a
 * warning and alerts admins once per pass. At `DISK_CRITICAL_PERCENT` it
 * deletes the local copies of events already on Drive (oldest first) and
 * prunes empty day-directories. At `DISK_EMERGENCY_PERCENT` it additionally
 * prunes day-old sent events and sensor logs, stops the Motion daemon, and
 * alerts admins.
 *
 * **Invariant:** only events with `uploadedToGdrive = true` are ever deleted,
 * so footage that never reached Drive is preserved even when the disk fills.
 */
@Injectable()
export class CleanupLocalStorageUseCase {
  private readonly logger = new Logger(CleanupLocalStorageUseCase.name);

  constructor(
    @Inject(LOCAL_STORAGE) private readonly storage: LocalStoragePort,
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
    @Inject(RETENTION_PRUNE) private readonly retention: RetentionPrunePort,
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(ADMIN_ALERT) private readonly adminAlert: AdminAlertPort,
  ) {}

  async execute(): Promise<void> {
    const usage = await this.storage.usagePercent();
    const critical = this.percentEnv('DISK_CRITICAL_PERCENT', DEFAULT_CRITICAL_PERCENT);
    if (usage < critical) {
      const warn = this.percentEnv('DISK_WARN_PERCENT', DEFAULT_WARN_PERCENT);
      if (usage >= warn) {
        this.logger.warn(`Disk at ${usage}% (warn ${warn}%) — approaching critical`);
        await this.adminAlert.alert('disk-warning');
      }
      return;
    }

    this.logger.warn(`Disk at ${usage}% (critical ${critical}%) — cleaning uploaded media`);
    const candidates = await this.media.findUploadedNotDeleted();
    for (const event of candidates) {
      if (event.videoPath) await this.storage.deleteFile(event.videoPath);
      if (event.snapshotPath) await this.storage.deleteFile(event.snapshotPath);
      await this.writer.markLocalDeleted(event.id);
    }
    await this.storage.pruneEmptyDirs();

    const emergency = this.percentEnv(
      'DISK_EMERGENCY_PERCENT',
      DEFAULT_EMERGENCY_PERCENT,
    );
    if (usage < emergency) return;

    await this.runEmergency();
  }

  private async runEmergency(): Promise<void> {
    this.logger.error('Disk at emergency level — pruning logs/events and stopping motion');
    const cutoff = new Date(Date.now() - DAY_MS);
    await this.retention.pruneEventsOlderThan(cutoff);
    await this.retention.pruneSensorLogsOlderThan(cutoff);
    try {
      await this.motion.stop();
    } catch (err) {
      this.logger.warn(`Failed to stop motion during emergency: ${(err as Error).message}`);
    }
    await this.adminAlert.alert('emergency-disk-cleanup');
  }

  private percentEnv(key: string, fallback: number): number {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}
