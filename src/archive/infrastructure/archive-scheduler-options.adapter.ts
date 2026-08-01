import type { DefaultsConfig } from '../../config/config.loader';
import type { ArchiveSchedulerOptions } from '../application/archive-scheduler.service';

const INTERVAL_RANGE = { minimum: 30_000, maximum: 60 * 60 * 1_000 };
const LEASE_RANGE = { minimum: 60_000, maximum: 24 * 60 * 60 * 1_000 };
const VIDEO_BATCH_RANGE = { minimum: 1, maximum: 100 };

/** Applies bounded environment overrides to the checked-in archive defaults. */
export function archiveSchedulerOptionsFromConfig(
  defaults: DefaultsConfig['archive'],
  environment: Readonly<Record<string, string | undefined>>,
): ArchiveSchedulerOptions {
  return {
    intervalMs: boundedInteger(
      environment.ARCHIVE_SCHEDULER_INTERVAL_MS,
      defaults.scheduler_interval_ms,
      INTERVAL_RANGE,
    ),
    leaseMs: boundedInteger(
      environment.ARCHIVE_UPLOAD_LEASE_MS,
      defaults.upload_lease_ms,
      LEASE_RANGE,
    ),
    newerVideoBatch: boundedInteger(
      environment.ARCHIVE_NEWER_VIDEO_BATCH,
      defaults.newer_video_batch,
      VIDEO_BATCH_RANGE,
    ),
  };
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  range: { minimum: number; maximum: number },
): number {
  const parsed = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < range.minimum || parsed > range.maximum) {
    return fallback;
  }
  return parsed;
}
