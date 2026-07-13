import { isAbsolute, normalize } from 'node:path';

/** Resolved camera runtime mode (real Motion daemon vs. stub). */
export const CAMERA_MODE = Symbol('CAMERA_MODE');
export type CameraMode = 'real' | 'stub';

export const LIVE_STREAM_OPTIONS = Symbol('LIVE_STREAM_OPTIONS');

export interface LiveStreamOptions {
  enabled: boolean;
  durationMs: number;
  startTimeoutMs: number;
  maxViewers: number;
  runtimeDirectory: string;
}

const DEFAULTS: LiveStreamOptions = {
  enabled: false,
  durationMs: 300_000,
  startTimeoutMs: 30_000,
  maxViewers: 2,
  runtimeDirectory: '/run/home-worker/live-stream',
};

export function liveStreamOptionsFromEnv(
  env: Record<string, string | undefined>,
): LiveStreamOptions {
  return {
    enabled: env.LIVE_STREAM_ENABLED === 'true',
    durationMs: boundedInteger(env.LIVE_STREAM_DURATION_MS, 1_000, 300_000, DEFAULTS.durationMs),
    startTimeoutMs: boundedInteger(
      env.LIVE_STREAM_START_TIMEOUT_MS,
      1_000,
      120_000,
      DEFAULTS.startTimeoutMs,
    ),
    maxViewers: boundedInteger(env.LIVE_STREAM_MAX_VIEWERS, 1, 2, DEFAULTS.maxViewers),
    runtimeDirectory: runtimeDirectory(env.LIVE_STREAM_RUNTIME_DIR),
  };
}

const SAFE_RUNTIME_ROOTS = [
  '/run/home-worker',
  '/opt/home-worker',
  '/tmp',
  '/private/var/folders',
] as const;

function runtimeDirectory(raw: string | undefined): string {
  if (
    raw === undefined ||
    raw.length === 0 ||
    raw.length > 1_024 ||
    raw !== raw.trim() ||
    /[\0-\x1f\x7f]/.test(raw) ||
    !isAbsolute(raw) ||
    raw.split('/').includes('..')
  ) {
    return DEFAULTS.runtimeDirectory;
  }

  const normalized = normalize(raw);
  if (!SAFE_RUNTIME_ROOTS.some((root) => normalized.startsWith(`${root}/`))) {
    return DEFAULTS.runtimeDirectory;
  }
  return normalized;
}

function boundedInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}
