import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export interface DefaultsConfig {
  sensor_defaults: Record<string, Record<string, unknown>>;
  notifications: {
    quiet_hours_default: string | null;
    max_queue_before_force_aggregate: number;
  };
}

let cached: DefaultsConfig | undefined;

export function loadDefaults(path = './config/defaults.yml'): DefaultsConfig {
  if (cached) return cached;
  const text = readFileSync(resolve(path), 'utf8');
  cached = parse(text) as DefaultsConfig;
  return cached;
}
