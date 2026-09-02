import { describe, expect, it, vi } from 'vitest';
import { ArchiveSchedulerHooksService } from '../../src/archive/application/archive-scheduler.service';
import { ARCHIVE_RUNTIME_SIGNAL } from '../../src/archive/application/ports/archive-runtime-signal.port';
import { CleanupCoordinatorService } from '../../src/camera/application/cleanup-coordinator.service';
import { CompletedMotionVideoRecoveryScheduler } from '../../src/camera/application/completed-motion-video-recovery.scheduler';
import { CameraSourceAuthorizationRegistry } from '../../src/camera/application/camera-source-authorization-registry.service';
import { RecordMotionEndUseCase } from '../../src/camera/application/record-motion-end.use-case';
import { RegisterCompletedMotionVideosUseCase } from '../../src/camera/application/register-completed-motion-videos.use-case';
import { CameraModule } from '../../src/camera/camera.module';
import { CameraNameTakenError } from '../../src/camera/domain/errors/camera-name-taken.error';
import { CAMERA_SOURCE_AUTHORIZATION } from '../../src/camera/domain/ports/camera-source-authorization.port';
import { LIVE_SOURCE_REPOSITORY } from '../../src/camera/domain/ports/live-source-repository.port';
import { MEDIA_REPOSITORY } from '../../src/camera/domain/ports/media-repository.port';
import { MEDIA_WRITER } from '../../src/camera/domain/ports/media-writer.port';
import { RTSP_SOURCE_CONFIGURATION } from '../../src/camera/domain/ports/rtsp-source-configuration.port';
import { AesGcmLiveSourceCredentialAdapter } from '../../src/camera/infrastructure/aes-gcm-live-source-credential.adapter';
import { InMemoryLiveSourceRepository } from '../../src/camera/infrastructure/in-memory-live-source.repository';
import { InMemoryMediaRepository } from '../../src/camera/infrastructure/in-memory-media.repository';
import { DB } from '../../src/database/database.module';
import { FEATURE_AVAILABILITY } from '../../src/features/domain/ports/feature-availability.port';
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
  it('wires successful Motion-end registration to the recovery wake through the provider graph', async () => {
    interface ProviderMetadata {
      provide?: unknown;
      inject?: readonly unknown[];
      useFactory?: (...dependencies: unknown[]) => unknown;
    }
    const providers = Reflect.getMetadata('providers', CameraModule) as unknown[];
    const provider = providers.find(
      (candidate): candidate is ProviderMetadata => typeof candidate === 'object'
        && candidate !== null
        && 'provide' in candidate
        && candidate.provide === RecordMotionEndUseCase,
    );

    expect(provider?.inject).toEqual([
      MEDIA_REPOSITORY,
      MEDIA_WRITER,
      FEATURE_AVAILABILITY,
      RegisterCompletedMotionVideosUseCase,
      CompletedMotionVideoRecoveryScheduler,
    ]);
    if (!provider?.useFactory) throw new Error('RecordMotionEndUseCase factory is unavailable');

    const registration = { executeForEvent: vi.fn(async () => undefined) };
    const recovery = { wake: vi.fn() };
    const useCase = provider.useFactory(
      { listCameras: vi.fn(async () => [{ id: 'front', name: 'Front' }]) },
      { closeLatestOpenEvent: vi.fn(async () => ({ id: 42 })) },
      { requireReady: vi.fn(async () => undefined) },
      registration,
      recovery,
    ) as RecordMotionEndUseCase;

    await useCase.execute('front', '/motion/2026/08/29/123456-event.mp4');

    expect(registration.executeForEvent).toHaveBeenCalledWith(42);
    expect(recovery.wake).toHaveBeenCalledWith('motion-event');
  });

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

  interface ModuleClass {
    readonly name: string;
  }

  /** Every module reachable from `root` through the Nest `imports` metadata. */
  function importGraph(root: unknown): Set<ModuleClass> {
    const seen = new Set<ModuleClass>();
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const candidate = pending.pop();
      const module = typeof candidate === 'object' && candidate !== null && 'module' in candidate
        ? (candidate).module
        : candidate;
      if (typeof module !== 'function' || seen.has(module)) continue;
      seen.add(module);
      pending.push(...((Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? []));
    }
    return seen;
  }

  it('never reaches the Telegram context, at any import depth', () => {
    const names = [...importGraph(CameraModule)].map((module) => module.name);

    expect(names).toContain('CameraModule');
    expect(names).toContain('FeatureModule');
    expect(names).not.toContain('TelegramModule');
  });

  it('reaches the verified RTSP policy through the Features port alone', () => {
    expect(Reflect.getMetadata('imports', CameraModule) as unknown[]).toContain(FeatureModule);
    expect(Reflect.getMetadata('exports', FeatureModule) as unknown[]).toContain(RTSP_POLICY_STATUS);

    // Camera consumes the exported token; it never binds the Features adapter.
    const bindsPolicyStatus = cameraProviders().some(
      (candidate) => typeof candidate === 'object'
        && candidate !== null
        && 'provide' in candidate
        && (candidate as ProviderMetadata).provide === RTSP_POLICY_STATUS,
    );
    expect(bindsPolicyStatus).toBe(false);
  });
});


describe('CameraModule name-key backfill composition', () => {
  interface FactoryProvider {
    provide?: unknown;
    inject?: unknown[];
    useFactory?: (...args: unknown[]) => unknown;
  }

  function configurationProvider(): FactoryProvider {
    const providers = Reflect.getMetadata('providers', CameraModule) as unknown[];
    const provider = providers.find(
      (candidate): candidate is FactoryProvider =>
        typeof candidate === 'object'
        && candidate !== null
        && 'provide' in candidate
        && (candidate as FactoryProvider).provide === RTSP_SOURCE_CONFIGURATION,
    );
    if (!provider) throw new Error('RTSP_SOURCE_CONFIGURATION is not provided');
    return provider;
  }

  it('takes the media repository and the source repository as its dependencies', () => {
    expect(configurationProvider().inject).toEqual([
      MEDIA_REPOSITORY,
      LIVE_SOURCE_REPOSITORY,
      DB,
    ]);
  });

  /**
   * The backfill's ordering guarantee comes from sitting inside this factory,
   * which is a side effect nothing else would notice if the port were moved or
   * provided elsewhere. Pin it: the port must not be obtainable before it runs.
   */
  it('awaits the name-key backfill before yielding the configuration port', async () => {
    const media = new InMemoryMediaRepository();
    const sources = new InMemoryLiveSourceRepository(
      new AesGcmLiveSourceCredentialAdapter({ currentKey: '11'.repeat(32), currentVersion: 1 }),
    );
    const order: string[] = [];
    vi.spyOn(media, 'backfillNameKeys').mockImplementation(async () => {
      order.push('backfill');
    });

    const adapter = await configurationProvider().useFactory?.(media, sources, {});
    order.push('port resolved');

    expect(order).toEqual(['backfill', 'port resolved']);
    expect(adapter).toEqual(
      expect.objectContaining({
        createCamera: expect.any(Function),
        attach: expect.any(Function),
        replace: expect.any(Function),
        remove: expect.any(Function),
      }),
    );
  });

  it('still yields the port when the backfill refuses, so one bad name cannot stop boot', async () => {
    const media = new InMemoryMediaRepository();
    const sources = new InMemoryLiveSourceRepository(
      new AesGcmLiveSourceCredentialAdapter({ currentKey: '11'.repeat(32), currentVersion: 1 }),
    );
    vi.spyOn(media, 'backfillNameKeys').mockRejectedValue(new CameraNameTakenError());

    await expect(
      configurationProvider().useFactory?.(media, sources, {}),
    ).resolves.toBeDefined();
  });
});
