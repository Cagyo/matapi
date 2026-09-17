import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Provider {
  provide?: { description?: string; name?: string };
  useFactory?: (...args: unknown[]) => unknown;
  useExisting?: { description?: string };
  useClass?: { name?: string };
  inject?: { description?: string }[];
}

async function runtimeAdapters(mode: 'real' | 'stub') {
  vi.resetModules();
  vi.stubEnv('CAMERA_MODE', mode);
  const { CameraModule } = await import('../../src/camera/camera.module');
  const providers = Reflect.getMetadata('providers', CameraModule) as Provider[];
  const create = (description: string, ...args: unknown[]) => {
    const provider = providers.find((candidate) => candidate.provide?.description === description);
    expect(provider?.useFactory).toBeTypeOf('function');
    return provider?.useFactory?.(...args);
  };
  const gateway = providers.find((candidate) => candidate.provide?.description === 'LIVE_STREAM_GATEWAY');
  const probe = providers.find((candidate) => candidate.provide?.description === 'LIVE_SOURCE_PROBE');
  const recovery = providers.find(
    (candidate) => candidate.provide?.name === 'CompletedMotionVideoRecoveryScheduler',
  );
  const settings = await create('LIVE_VIEW_SETTINGS_STORE');
  const jobs = providers.find(provider => provider.provide?.description === 'LIVE_VIEW_SETTINGS_JOB_REPOSITORY');
  const capability = providers.find(provider => provider.provide?.description === 'LIVE_STREAM_CAPABILITY');
  return {
    egress: create('STREAM_EGRESS'),
    sandbox: create('STREAM_SANDBOX', { allowedCidrs: '192.168.0.0/16', udpPortFirst: 24000, udpPortLast: 24001 }),
    gatewayInjectsRuntime: gateway?.inject?.some((token) => token.description === 'RTSP_STREAM_RUNTIME'),
    probeCoordinator: probe?.useExisting?.description,
    recoveryRuntimeSignal: recovery?.inject?.some(
      (token) => token.description === 'ARCHIVE_RUNTIME_SIGNAL',
    ),
    settings: settings?.constructor.name,
    jobs: jobs?.useClass?.name,
    detector: create('PRIVATE_SUBNET_DETECTOR')?.constructor.name,
    policy: ['LIVE_VIEW_POLICY_REQUEST', 'LIVE_VIEW_POLICY_RESULT', 'LIVE_VIEW_POLICY_ACKNOWLEDGEMENT', 'LIVE_VIEW_POLICY_CONTROLLER'].map(token => {
      const provider = providers.find(candidate => candidate.provide?.description === token);
      return provider?.useFactory?.()?.constructor.name ?? (provider?.useExisting as { name?: string })?.name;
    }),
    capabilityInjectsOptions: capability?.inject?.some(token => token.description === 'LIVE_STREAM_OPTIONS') ?? false,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('CameraModule restricted RTSP runtime composition', () => {
  it('wires the nft helper and systemd sandbox only in real mode', async () => {
    const adapters = await runtimeAdapters('real');
    expect(adapters.egress?.constructor.name).toBe('NftStreamEgressAdapter');
    expect(adapters.sandbox?.constructor.name).toBe('SystemdFfmpegStreamAdapter');
    expect(adapters.gatewayInjectsRuntime).toBe(true);
    expect(adapters.probeCoordinator).toBe('RTSP_RUNTIME_COORDINATOR');
    expect(adapters.recoveryRuntimeSignal).toBe(true);
    expect(adapters).toMatchObject({ settings: 'FsLiveViewSettingsAdapter', jobs: 'DrizzleLiveViewSettingsJobRepository',
      detector: 'OsPrivateSubnetDetectorAdapter', capabilityInjectsOptions: false,
      policy: ['FsLiveViewPolicyRequestAdapter', 'FsLiveViewPolicyResultAdapter', 'FsLiveViewPolicyAcknowledgementAdapter', 'SystemdLiveViewPolicyControllerAdapter'] });
  }, 15_000);

  it('keeps both privileged runtime ports unavailable in stub mode', async () => {
    const adapters = await runtimeAdapters('stub');
    expect(adapters.egress?.constructor.name).toBe('UnavailableStreamEgressAdapter');
    expect(adapters.sandbox?.constructor.name).toBe('UnavailableStreamSandboxAdapter');
    expect(adapters.gatewayInjectsRuntime).toBe(true);
    expect(adapters.recoveryRuntimeSignal).toBe(true);
    expect(adapters).toMatchObject({ settings: 'InMemoryLiveViewSettingsAdapter', jobs: 'InMemoryLiveViewSettingsJobRepository',
      policy: Array(4).fill('InMemoryLiveViewPolicyAdapter') });
  }, 15_000);
});
