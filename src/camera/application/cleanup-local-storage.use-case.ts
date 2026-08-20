import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ARCHIVE_VERIFICATION,
  type ArchiveVerificationPort,
} from '../../archive/application/ports/archive-verification.port';
import { ArchiveRemoteMutationLockService } from '../../archive/application/archive-remote-mutation-lock.service';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import { MOTION_DESIRED_STATE_KEY } from '../domain/motion-desired-state';
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
/** Stop deleting once usage drops this many points below the threshold. */
const TARGET_HYSTERESIS = 5;
const WARN_ALERT_KEY = 'last_alert_disk_warning';
const WARN_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EMERGENCY_ALERT_KEY = 'last_alert_emergency_cleanup';
const EMERGENCY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Local storage cleanup loop (spec 21, 23). At `DISK_WARN_PERCENT` it alerts
 * admins (at most once per 24h). At `DISK_CRITICAL_PERCENT` (or configured
 * `auto_clean_threshold`) it deletes the local copies of events already on
 * Drive — oldest first, re-measuring the disk after each event group and
 * stopping once below threshold−hysteresis. At `DISK_EMERGENCY_PERCENT` (re-measured after
 * the deletions, so a successful cleanup de-escalates) it additionally prunes
 * day-old sent events and sensor logs, records `motion_desired_state=off`,
 * stops the Motion daemon, and alerts admins (at most once per 6h).
 *
 * **Invariant:** only a current active-generation exact-ID verification plus
 * an unchanged trusted local source can authorize deletion. Bulk-copy times,
 * legacy upload flags, and unreferenced-file age never authorize deletion.
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
    @Inject(ARCHIVE_VERIFICATION) private readonly archive: ArchiveVerificationPort,
    @Inject(ArchiveRemoteMutationLockService)
    private readonly activityGate: Pick<ArchiveRemoteMutationLockService, 'tryRunCleanup'> =
      new ArchiveRemoteMutationLockService(),
  ) {}

  async execute(
    customThreshold?: number,
    signal?: AbortSignal,
  ): Promise<{ thresholdUsed: number }> {
    throwIfAborted(signal);
    const usage = await this.storage.usagePercent();
    throwIfAborted(signal);
    const critical = await this.resolveThreshold(customThreshold, signal);
    throwIfAborted(signal);
    if (usage < critical) {
      const warn = this.percentEnv('DISK_WARN_PERCENT', DEFAULT_WARN_PERCENT);
      if (usage >= warn) {
        this.logger.warn(`Disk at ${usage}% (warn ${warn}%) — approaching critical`);
        await this.sendCooldownAlert(
          WARN_ALERT_KEY,
          WARN_ALERT_COOLDOWN_MS,
          'disk-warning',
          signal,
        );
      }
      return { thresholdUsed: critical };
    }

    const cleanup = await this.activityGate.tryRunCleanup(async () => {
      this.logger.warn(`Disk at ${usage}% (critical ${critical}%) — cleaning uploaded media`);
      await this.deleteUploadedUntilBelow(
        Math.max(critical - TARGET_HYSTERESIS, 10),
        signal,
      );
      throwIfAborted(signal);
      await this.storage.pruneEmptyDirs();
      throwIfAborted(signal);

      const emergency = this.percentEnv(
        'DISK_EMERGENCY_PERCENT',
        DEFAULT_EMERGENCY_PERCENT,
      );
      // Re-measure: the deletions above may already have de-escalated the disk.
      const usageAfter = await this.storage.usagePercent();
      throwIfAborted(signal);
      if (usageAfter >= emergency) await this.runEmergency(signal);
      return { thresholdUsed: critical };
    });
    return cleanup ?? { thresholdUsed: critical };
  }

  /** Oldest-first deletion with per-event re-measurement, stopping at target. */
  private async deleteUploadedUntilBelow(
    targetPercent: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidates = await this.media.findUploadedNotDeleted();
    throwIfAborted(signal);
    let markedDeleted = 0;
    const verified = new Map<string, boolean>();
    for (const event of candidates) {
      throwIfAborted(signal);
      const artifactId = event.archiveArtifactId;
      if (artifactId === null) continue;
      let cleanupSafe = verified.get(artifactId);
      if (cleanupSafe === undefined) {
        cleanupSafe = (await this.archive.inspect(artifactId)).cleanupSafe;
        verified.set(artifactId, cleanupSafe);
      }
      throwIfAborted(signal);
      if (!cleanupSafe) continue;
      const videoDeleted = event.videoPath
        ? await this.storage.deleteFile(event.videoPath)
        : true;
      throwIfAborted(signal);
      const snapshotDeleted = event.snapshotPath
        ? await this.storage.deleteFile(event.snapshotPath)
        : true;
      throwIfAborted(signal);

      if (videoDeleted && snapshotDeleted) {
        await this.writer.markLocalDeleted(event.id);
        throwIfAborted(signal);
        markedDeleted += 1;
      } else {
        this.logger.warn(
          `Event ${event.id}: keeping DB row local-deleted=false because a file deletion failed`,
        );
      }

      const usage = await this.storage.usagePercent();
      throwIfAborted(signal);
      if (usage < targetPercent) {
        break;
      }
    }
    if (markedDeleted > 0) {
      this.logger.log(`Deleted local copies of ${markedDeleted} uploaded event(s)`);
    }
  }

  private async runEmergency(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.logger.error('Disk at emergency level — pruning logs/events and stopping motion');
    const cutoff = new Date(Date.now() - DAY_MS);
    await this.retention.pruneEventsOlderThan(cutoff);
    throwIfAborted(signal);
    await this.retention.pruneSensorLogsOlderThan(cutoff);
    throwIfAborted(signal);
    // Record the stop as intentional so the watcher doesn't immediately
    // restart Motion and refill the disk. /camera enable re-arms it.
    try {
      await this.meta.set(MOTION_DESIRED_STATE_KEY, 'off');
      throwIfAborted(signal);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      this.logger.warn('Failed to record desired motion state during emergency: CAMERA_OPERATION_FAILED');
    }
    try {
      await this.motion.stop();
      throwIfAborted(signal);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      this.logger.warn('Failed to stop motion during emergency: CAMERA_OPERATION_FAILED');
    }
    await this.sendCooldownAlert(
      EMERGENCY_ALERT_KEY,
      EMERGENCY_ALERT_COOLDOWN_MS,
      'emergency-disk-cleanup',
      signal,
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
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (!(await this.shouldSendAlert(key, cooldownMs, signal))) return;
    throwIfAborted(signal);
    try {
      await this.adminAlert.alert(kind);
      throwIfAborted(signal);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      this.logger.warn(`Failed to send ${kind} alert: CAMERA_OPERATION_FAILED`);
      return;
    }
    try {
      await this.meta.set(key, String(Date.now()));
      throwIfAborted(signal);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      this.logger.warn(`Failed to record ${kind} alert cooldown: CAMERA_OPERATION_FAILED`);
    }
  }

  /** True when the cooldown window has elapsed or can't be checked safely. */
  private async shouldSendAlert(
    key: string,
    cooldownMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const raw = await this.meta.get(key);
      throwIfAborted(signal);
      const last = raw === null ? NaN : Number(raw);
      return !(Number.isFinite(last) && Date.now() - last < cooldownMs);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      this.logger.warn(`Failed to read ${key} cooldown: CAMERA_OPERATION_FAILED`);
      return true;
    }
  }

  private async resolveThreshold(custom?: number, signal?: AbortSignal): Promise<number> {
    if (custom !== undefined && Number.isFinite(custom) && custom >= 10 && custom <= 99) {
      return Math.trunc(custom);
    }
    const rawMeta = await this.meta.get('auto_clean_threshold');
    throwIfAborted(signal);
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
