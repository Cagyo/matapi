import type { DefaultsConfig } from '../../config/config.loader';

const ENTRY_LIMIT_RANGE = { minimum: 1, maximum: 256 };
const HASH_BYTE_LIMIT_RANGE = { minimum: 65_536, maximum: 67_108_864 };
const WALL_TIME_RANGE = { minimum: 10, maximum: 1_000 };
const DESCRIPTOR_LIMIT_RANGE = { minimum: 1, maximum: 64 };

export interface CompletedMotionRecoveryOptions {
  entryLimit: number;
  hashByteLimit: number;
  wallTimeMs: number;
  descriptorLimit: number;
}

/** Applies bounded environment overrides to the checked-in recovery defaults. */
export function completedMotionRecoveryOptionsFromConfig(
  defaults: DefaultsConfig['archive'],
  environment: Readonly<Record<string, string | undefined>>,
): CompletedMotionRecoveryOptions {
  return {
    entryLimit: boundedInteger(
      environment.ARCHIVE_MOTION_RECOVERY_ENTRY_LIMIT,
      defaults.motion_recovery_entry_limit,
      ENTRY_LIMIT_RANGE,
    ),
    hashByteLimit: boundedInteger(
      environment.ARCHIVE_MOTION_RECOVERY_HASH_BYTES,
      defaults.motion_recovery_hash_bytes,
      HASH_BYTE_LIMIT_RANGE,
    ),
    wallTimeMs: boundedInteger(
      environment.ARCHIVE_MOTION_RECOVERY_WALL_TIME_MS,
      defaults.motion_recovery_wall_time_ms,
      WALL_TIME_RANGE,
    ),
    descriptorLimit: boundedInteger(
      environment.ARCHIVE_MOTION_RECOVERY_DESCRIPTOR_LIMIT,
      defaults.motion_recovery_descriptor_limit,
      DESCRIPTOR_LIMIT_RANGE,
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
