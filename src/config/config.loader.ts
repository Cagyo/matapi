import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export interface DefaultsConfig {
  sensor_defaults: Record<string, Record<string, unknown>>;
  notifications: {
    quiet_hours_default: string | null;
    max_queue_before_force_aggregate: number;
  };
  archive: {
    scheduler_interval_ms: number;
    upload_lease_ms: number;
    newer_video_batch: number;
    motion_recovery_entry_limit: number;
    motion_recovery_hash_bytes: number;
    motion_recovery_wall_time_ms: number;
    motion_recovery_descriptor_limit: number;
  };
}

let cached: DefaultsConfig | undefined;

export function loadDefaults(path = './config/defaults.yml'): DefaultsConfig {
  if (cached) return cached;
  const text = readFileSync(resolve(path), 'utf8');
  cached = parse(text) as DefaultsConfig;
  return cached;
}
