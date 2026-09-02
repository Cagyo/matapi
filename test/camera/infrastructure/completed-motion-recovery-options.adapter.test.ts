import { describe, expect, it } from 'vitest';
import { completedMotionRecoveryOptionsFromConfig } from '../../../src/camera/infrastructure/completed-motion-recovery-options.adapter';

describe('completedMotionRecoveryOptionsFromConfig', () => {
  const defaults = {
    scheduler_interval_ms: 120_000,
    upload_lease_ms: 300_000,
    newer_video_batch: 3,
    motion_recovery_entry_limit: 64,
    motion_recovery_hash_bytes: 8_388_608,
    motion_recovery_wall_time_ms: 100,
    motion_recovery_descriptor_limit: 16,
  };

  it('maps the checked-in recovery defaults', () => {
    expect(completedMotionRecoveryOptionsFromConfig(defaults, {})).toEqual({
      entryLimit: 64,
      hashByteLimit: 8_388_608,
      wallTimeMs: 100,
      descriptorLimit: 16,
    });
  });

  it('accepts inclusive bounded environment overrides', () => {
    expect(completedMotionRecoveryOptionsFromConfig(defaults, {
      ARCHIVE_MOTION_RECOVERY_ENTRY_LIMIT: '256',
      ARCHIVE_MOTION_RECOVERY_HASH_BYTES: '65536',
      ARCHIVE_MOTION_RECOVERY_WALL_TIME_MS: '1000',
      ARCHIVE_MOTION_RECOVERY_DESCRIPTOR_LIMIT: '1',
    })).toEqual({
      entryLimit: 256,
      hashByteLimit: 65_536,
      wallTimeMs: 1_000,
      descriptorLimit: 1,
    });
  });

  it.each([
    ['fractions', '1.5', '65536.5', '10.5', '1.5'],
    ['below minimums', '0', '65535', '9', '0'],
    ['above maximums', '257', '67108865', '1001', '65'],
    ['unsafe numbers', '99999999999999999', '99999999999999999', '99999999999999999', '99999999999999999'],
    ['non-numbers', 'many', 'many', 'many', 'many'],
    ['blank values', ' ', '', '\t', '  '],
  ])('falls back to defaults for %s', (_case, entryLimit, hashBytes, wallTime, descriptorLimit) => {
    expect(completedMotionRecoveryOptionsFromConfig(defaults, {
      ARCHIVE_MOTION_RECOVERY_ENTRY_LIMIT: entryLimit,
      ARCHIVE_MOTION_RECOVERY_HASH_BYTES: hashBytes,
      ARCHIVE_MOTION_RECOVERY_WALL_TIME_MS: wallTime,
      ARCHIVE_MOTION_RECOVERY_DESCRIPTOR_LIMIT: descriptorLimit,
    })).toEqual({
      entryLimit: 64,
      hashByteLimit: 8_388_608,
      wallTimeMs: 100,
      descriptorLimit: 16,
    });
  });
});
