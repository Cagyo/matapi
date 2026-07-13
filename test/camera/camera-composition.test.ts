import { describe, expect, it } from 'vitest';
import {
  liveStreamOptionsFromEnv,
  type LiveStreamOptions,
} from '../../src/camera/camera.tokens';

describe('CameraModule live-stream composition', () => {
  it('uses the safe live-stream defaults', () => {
    expect(liveStreamOptionsFromEnv({})).toEqual<LiveStreamOptions>({
      enabled: false,
      durationMs: 300_000,
      startTimeoutMs: 30_000,
      maxViewers: 2,
      runtimeDirectory: '/run/home-worker/live-stream',
    });
  });

  it('falls back or caps unsafe numeric configuration', () => {
    expect(liveStreamOptionsFromEnv({
      LIVE_STREAM_ENABLED: 'true',
      LIVE_STREAM_DURATION_MS: '999999999999',
      LIVE_STREAM_START_TIMEOUT_MS: '-1',
      LIVE_STREAM_MAX_VIEWERS: '999',
      LIVE_STREAM_RUNTIME_DIR: '',
    })).toEqual<LiveStreamOptions>({
      enabled: true,
      durationMs: 300_000,
      startTimeoutMs: 30_000,
      maxViewers: 2,
      runtimeDirectory: '/run/home-worker/live-stream',
    });
  });
});
