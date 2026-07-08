import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolve } from 'node:path';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import { MOTION_DESIRED_STATE_KEY } from '../domain/motion-desired-state';
import { ADMIN_ALERT, AdminAlertPort } from '../domain/ports/admin-alert.port';
import {
  GDRIVE_SYNC_HEALTH,
  GdriveSyncHealthPort,
} from '../domain/ports/gdrive-sync-health.port';
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
/** Stop deleting once usage drops this many points below the threshold. */
const TARGET_HYSTERESIS = 5;
/** Unreferenced local files older than this are sweepable orphans. */
const ORPHAN_MIN_AGE_DAYS = 7;
/** Must match the rclone `copyMotionFiles --min-age 1m` contract. */
const RCLONE_COPY_MIN_AGE_MS = 60_000;
const WARN_ALERT_KEY = 'last_alert_disk_warning';
const WARN_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EMERGENCY_ALERT_KEY = 'last_alert_emergency_cleanup';
const EMERGENCY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Local storage cleanup loop (spec 21, 23). At `DISK_WARN_PERCENT` it alerts
 * admins (at most once per 24h). At `DISK_CRITICAL_PERCENT` (or configured
 * `auto_clean_threshold`) it deletes the local copies of events already on
 * Drive — oldest first, re-measuring the disk after each event group and
 * stopping once below threshold−hysteresis — then sweeps orphaned segment
 * files the DB never tracked. At `DISK_EMERGENCY_PERCENT` (re-measured after
 * the deletions, so a successful cleanup de-escalates) it additionally prunes
 * day-old sent events and sensor logs, records `motion_desired_state=off`,
 * stops the Motion daemon, and alerts admins (at most once per 6h).
 *
 * **Invariant:** only files provably on Drive are ever deleted — uploaded
 * events, or unreferenced files whose mtime and ctime prove they existed and
 * were old enough at the last successful bulk copy. Footage that never reached
 * Drive is preserved even when the disk fills.
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
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
    @Inject(GDRIVE_SYNC_HEALTH) private readonly health: GdriveSyncHealthPort,
  ) {}

  async execute(customThreshold?: number): Promise<{ thresholdUsed: number }> {
    const usage = await this.storage.usagePercent();
    const critical = await this.resolveThreshold(customThreshold);
    if (usage < critical) {
      const warn = this.percentEnv('DISK_WARN_PERCENT', DEFAULT_WARN_PERCENT);
      if (usage >= warn) {
        this.logger.warn(`Disk at ${usage}% (warn ${warn}%) — approaching critical`);
        await this.sendCooldownAlert(
          WARN_ALERT_KEY,
          WARN_ALERT_COOLDOWN_MS,
          'disk-warning',
        );
      }
      return { thresholdUsed: critical };
    }

    this.logger.warn(`Disk at ${usage}% (critical ${critical}%) — cleaning uploaded media`);
    await this.deleteUploadedUntilBelow(Math.max(critical - TARGET_HYSTERESIS, 10));
    await this.storage.pruneEmptyDirs();
    await this.sweepOrphans();

    const emergency = this.percentEnv(
      'DISK_EMERGENCY_PERCENT',
      DEFAULT_EMERGENCY_PERCENT,
    );
    // Re-measure: the deletions above may already have de-escalated the disk.
    const usageAfter = await this.storage.usagePercent();
    if (usageAfter < emergency) return { thresholdUsed: critical };

    await this.runEmergency();
    return { thresholdUsed: critical };
  }

  /** Oldest-first deletion with per-event re-measurement, stopping at target. */
  private async deleteUploadedUntilBelow(targetPercent: number): Promise<void> {
    const candidates = await this.media.findUploadedNotDeleted();
    let markedDeleted = 0;
    for (const event of candidates) {
      const videoDeleted = event.videoPath
        ? await this.storage.deleteFile(event.videoPath)
        : true;
      const snapshotDeleted = event.snapshotPath
        ? await this.storage.deleteFile(event.snapshotPath)
        : true;

      if (videoDeleted && snapshotDeleted) {
        await this.writer.markLocalDeleted(event.id);
        markedDeleted += 1;
      } else {
        this.logger.warn(
          `Event ${event.id}: keeping DB row local-deleted=false because a file deletion failed`,
        );
      }

      if ((await this.storage.usagePercent()) < targetPercent) {
        break;
      }
    }
    if (markedDeleted > 0) {
      this.logger.log(`Deleted local copies of ${markedDeleted} uploaded event(s)`);
    }
  }

  /**
   * Deletes files under the Motion dir that no event references (30s segments
   * beyond the one the event-end hook recorded, leftovers from missed hooks).
   * Gated on a bulk-copy success in the last 24h. A candidate must have mtime
   * and ctime at least `--min-age` older than that success: mtime proves rclone
   * would include it, and ctime proves it wasn't restored/copied in after the
   * successful sync with an old timestamp.
   *
   * Path identity: DB paths (Motion's `%f`) and this walk both derive from the
   * same `MOTION_LOCAL_DIR`/`target_dir` config (spec 20); the lexical
   * `resolve()` comparison assumes no symlink aliasing between them. Even if
   * that assumption breaks, the mtime/ctime gate bounds the damage: rclone's
   * bulk copy reads the very tree walked here, so anything swept provably
   * exists on Drive — only local availability is at risk, never the archive.
   */
  private async sweepOrphans(): Promise<void> {
    const { lastSuccessAt } = this.health.snapshot();
    if (!lastSuccessAt || Date.now() - lastSuccessAt.getTime() > DAY_MS) {
      this.logger.debug('Skipping orphan sweep — no recent Drive sync success');
      return;
    }
    try {
      const cutoff = new Date(Date.now() - ORPHAN_MIN_AGE_DAYS * DAY_MS);
      const copySafeBeforeMs = lastSuccessAt.getTime() - RCLONE_COPY_MIN_AGE_MS;
      const referenced = new Set((await this.media.listAllMediaPaths()).map((p) => resolve(p)));
      const oldFiles = await this.storage.listFilesOlderThan(cutoff);
      let swept = 0;
      for (const file of oldFiles) {
        const path = resolve(file.path);
        if (referenced.has(path)) continue;
        if (file.mtimeMs > copySafeBeforeMs || file.ctimeMs > copySafeBeforeMs) continue;
        if (await this.storage.deleteFile(path)) swept += 1;
      }
      if (swept > 0) {
        this.logger.log(
          `Swept ${swept} orphaned media file(s) older than ${ORPHAN_MIN_AGE_DAYS}d`,
        );
        await this.storage.pruneEmptyDirs();
      }
    } catch (err) {
      this.logger.warn(`Skipping orphan sweep after error: ${(err as Error).message}`);
    }
  }

  private async runEmergency(): Promise<void> {
    this.logger.error('Disk at emergency level — pruning logs/events and stopping motion');
    const cutoff = new Date(Date.now() - DAY_MS);
    await this.retention.pruneEventsOlderThan(cutoff);
    await this.retention.pruneSensorLogsOlderThan(cutoff);
    // Record the stop as intentional so the watcher doesn't immediately
    // restart Motion and refill the disk. /camera enable re-arms it.
    try {
      await this.meta.set(MOTION_DESIRED_STATE_KEY, 'off');
    } catch (err) {
      this.logger.warn(
        `Failed to record desired motion state during emergency: ${(err as Error).message}`,
      );
    }
    try {
      await this.motion.stop();
    } catch (err) {
      this.logger.warn(`Failed to stop motion during emergency: ${(err as Error).message}`);
    }
    await this.sendCooldownAlert(
      EMERGENCY_ALERT_KEY,
      EMERGENCY_ALERT_COOLDOWN_MS,
      'emergency-disk-cleanup',
    );
  }

  /**
   * Sends the alert once per cooldown window; records the cooldown only after
   * a successful send so a failed delivery can be retried later.
   */
  private async sendCooldownAlert(
    key: string,
    cooldownMs: number,
    kind: 'disk-warning' | 'emergency-disk-cleanup',
  ): Promise<void> {
    if (!(await this.shouldSendAlert(key, cooldownMs))) return;
    try {
      await this.adminAlert.alert(kind);
    } catch (err) {
      this.logger.warn(`Failed to send ${kind} alert: ${(err as Error).message}`);
      return;
    }
    try {
      await this.meta.set(key, String(Date.now()));
    } catch (err) {
      this.logger.warn(`Failed to record ${kind} alert cooldown: ${(err as Error).message}`);
    }
  }

  /** True when the cooldown window has elapsed or can't be checked safely. */
  private async shouldSendAlert(key: string, cooldownMs: number): Promise<boolean> {
    try {
      const raw = await this.meta.get(key);
      const last = raw === null ? NaN : Number(raw);
      return !(Number.isFinite(last) && Date.now() - last < cooldownMs);
    } catch (err) {
      this.logger.warn(`Failed to read ${key} cooldown: ${(err as Error).message}`);
      return true;
    }
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
    const envVal = Number(process.env.DISK_CRITICAL_PERCENT);
    if (Number.isFinite(envVal) && envVal >= 10 && envVal <= 99) {
      return Math.trunc(envVal);
    }
    return DEFAULT_CRITICAL_PERCENT;
  }

  private percentEnv(key: string, fallback: number): number {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}
