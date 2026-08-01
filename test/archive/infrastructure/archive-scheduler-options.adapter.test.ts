import { describe, expect, it } from 'vitest';
import { archiveSchedulerOptionsFromConfig } from '../../../src/archive/infrastructure/archive-scheduler-options.adapter';

describe('archiveSchedulerOptionsFromConfig', () => {
  const defaults = {
    scheduler_interval_ms: 120_000,
    upload_lease_ms: 300_000,
    newer_video_batch: 3,
  };

  it('uses the configured bounded defaults', () => {
    expect(archiveSchedulerOptionsFromConfig(defaults, {})).toEqual({
      intervalMs: 120_000,
      leaseMs: 300_000,
      newerVideoBatch: 3,
    });
  });

  it('accepts in-range environment overrides', () => {
    expect(archiveSchedulerOptionsFromConfig(defaults, {
      ARCHIVE_SCHEDULER_INTERVAL_MS: '60000',
      ARCHIVE_UPLOAD_LEASE_MS: '180000',
      ARCHIVE_NEWER_VIDEO_BATCH: '5',
    })).toEqual({ intervalMs: 60_000, leaseMs: 180_000, newerVideoBatch: 5 });
  });

  it('falls back when overrides are unsafe or unbounded', () => {
    expect(archiveSchedulerOptionsFromConfig(defaults, {
      ARCHIVE_SCHEDULER_INTERVAL_MS: '999999999999',
      ARCHIVE_UPLOAD_LEASE_MS: '-1',
      ARCHIVE_NEWER_VIDEO_BATCH: '0',
    })).toEqual({ intervalMs: 120_000, leaseMs: 300_000, newerVideoBatch: 3 });
  });
});
