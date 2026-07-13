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
    runtimeDirectory: env.LIVE_STREAM_RUNTIME_DIR?.trim() || DEFAULTS.runtimeDirectory,
  };
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
