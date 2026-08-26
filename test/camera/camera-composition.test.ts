import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveSchedulerHooksService } from '../../src/archive/application/archive-scheduler.service';
import { ARCHIVE_RUNTIME_SIGNAL } from '../../src/archive/application/ports/archive-runtime-signal.port';
import { CleanupCoordinatorService } from '../../src/camera/application/cleanup-coordinator.service';
import { CompletedMotionVideoRecoveryScheduler } from '../../src/camera/application/completed-motion-video-recovery.scheduler';
import { CameraSourceAuthorizationRegistry } from '../../src/camera/application/camera-source-authorization-registry.service';
import { CameraModule } from '../../src/camera/camera.module';
import { CAMERA_SOURCE_AUTHORIZATION } from '../../src/camera/domain/ports/camera-source-authorization.port';
import {
  liveStreamOptionsFromEnv,
  type LiveStreamOptions,
} from '../../src/camera/camera.tokens';
import { FeatureModule } from '../../src/features/feature.module';
import { RTSP_POLICY_STATUS } from '../../src/features/domain/ports/rtsp-policy-status.port';

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

  it.each([
    ['relative path', 'tmp/live-stream'],
    ['filesystem root', '/'],
    ['oversized path', `/${'a'.repeat(1_025)}`],
    ['whitespace-only path', '   '],
    ['leading whitespace', ' /tmp/live-stream'],
    ['path traversal', '/tmp/../etc/live-stream'],
    ['unsafe system root', '/etc/home-worker/live-stream'],
    ['root home', '/root/home-worker/live-stream'],
    ['user home', '/home/homeworker/live-stream'],
    ['library root', '/lib/home-worker/live-stream'],
    ['64-bit library root', '/lib64/home-worker/live-stream'],
    ['variable-data root', '/var/lib/home-worker/live-stream'],
    ['bare run safe root', '/run/home-worker'],
    ['bare opt safe root', '/opt/home-worker'],
    ['bare temp safe root', '/tmp'],
    ['bare macOS temp safe root', '/private/var/folders'],
  ])('falls back for an unsafe runtime directory: %s', (_case, runtimeDirectory) => {
    expect(liveStreamOptionsFromEnv({
      LIVE_STREAM_RUNTIME_DIR: runtimeDirectory,
    }).runtimeDirectory).toBe('/run/home-worker/live-stream');
  });

  it.each([
    '/run/home-worker/live-stream',
    '/tmp/home-worker-live-stream',
    '/private/var/folders/test/live-stream',
    '/opt/home-worker/runtime/live-stream',
  ])('accepts a reasonable absolute runtime directory: %s', (runtimeDirectory) => {
    expect(liveStreamOptionsFromEnv({
      LIVE_STREAM_RUNTIME_DIR: runtimeDirectory,
    }).runtimeDirectory).toBe(runtimeDirectory);
  });
});

describe('CameraModule archive recovery composition', () => {
  it('provides the recovery coordinator and routes Archive hooks through it', async () => {
    interface ProviderMetadata {
      provide?: unknown;
      inject?: readonly unknown[];
      useFactory?: (...dependencies: unknown[]) => unknown;
    }
    const providers = Reflect.getMetadata('providers', CameraModule) as unknown[];

    const recoveryProvider = providers.find(
      (provider): provider is ProviderMetadata => typeof provider === 'object'
        && provider !== null
        && 'provide' in provider
        && provider.provide === CompletedMotionVideoRecoveryScheduler,
    );
    expect(recoveryProvider).toMatchObject({
      inject: expect.arrayContaining([ARCHIVE_RUNTIME_SIGNAL]),
    });

    const hookRegistration = providers.find(
      (provider): provider is ProviderMetadata => typeof provider === 'object'
        && provider !== null
        && 'provide' in provider
        && provider.provide === 'ARCHIVE_CAMERA_SCHEDULER_HOOK_REGISTRATION',
    );
    expect(hookRegistration).toMatchObject({
      inject: [
        ArchiveSchedulerHooksService,
        CompletedMotionVideoRecoveryScheduler,
        CleanupCoordinatorService,
      ],
    });
    expect(hookRegistration?.useFactory).toBeTypeOf('function');

    const hooks = new ArchiveSchedulerHooksService();
    const reconcile = vi.fn(async (_signal?: AbortSignal) => undefined);
    const runCleanup = vi.fn(async () => ({ executed: true, thresholdUsed: 80 }));
    if (!hookRegistration?.useFactory) {
      throw new Error('Camera archive hook registration factory is unavailable');
    }
    hookRegistration.useFactory(hooks, { reconcile }, { runCleanup });
    const signal = new AbortController().signal;

    await hooks.reconcileMotion(signal);
    await hooks.cleanupLocal(signal);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(signal);
    expect(runCleanup).toHaveBeenCalledOnce();
    expect(runCleanup).toHaveBeenCalledWith('local', undefined, signal);
  });
});

describe('CameraModule mutation-guard composition', () => {
  interface ProviderMetadata {
    provide?: unknown;
    useExisting?: unknown;
  }

  function cameraProviders(): unknown[] {
    return Reflect.getMetadata('providers', CameraModule) as unknown[];
  }

  it('binds the camera authorization port to the late-binding registry', () => {
    const provider = cameraProviders().find(
      (candidate): candidate is ProviderMetadata => typeof candidate === 'object'
        && candidate !== null
        && 'provide' in candidate
        && candidate.provide === CAMERA_SOURCE_AUTHORIZATION,
    );

    expect(provider).toEqual({
      provide: CAMERA_SOURCE_AUTHORIZATION,
      useExisting: CameraSourceAuthorizationRegistry,
    });
    expect(cameraProviders()).toContain(CameraSourceAuthorizationRegistry);
  });

  it('exports the registry so the Telegram context can bind late', () => {
    const exports = Reflect.getMetadata('exports', CameraModule) as unknown[];

    expect(exports).toContain(CameraSourceAuthorizationRegistry);
  });

  it('reaches the verified RTSP policy through the Features port alone', () => {
    const imports = Reflect.getMetadata('imports', CameraModule) as unknown[];

    expect(imports).toContain(FeatureModule);
    expect(Reflect.getMetadata('exports', FeatureModule) as unknown[])
      .toContain(RTSP_POLICY_STATUS);

    const source = readFileSync(
      new URL('../../src/camera/camera.module.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('telegram');
    expect(source).not.toContain('InstalledRtspPolicyStatusAdapter');
  });
});
