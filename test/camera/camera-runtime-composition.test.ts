import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Provider {
  provide?: { description?: string };
  useFactory?: () => unknown;
  useExisting?: { description?: string };
  inject?: { description?: string }[];
}

async function runtimeAdapters(mode: 'real' | 'stub') {
  vi.resetModules();
  vi.stubEnv('CAMERA_MODE', mode);
  vi.stubEnv('RTSP_ALLOWED_CIDRS', '192.168.0.0/16');
  const { CameraModule } = await import('../../src/camera/camera.module');
  const providers = Reflect.getMetadata('providers', CameraModule) as Provider[];
  const create = (description: string) => {
    const provider = providers.find((candidate) => candidate.provide?.description === description);
    expect(provider?.useFactory).toBeTypeOf('function');
    return provider?.useFactory?.();
  };
  const gateway = providers.find((candidate) => candidate.provide?.description === 'LIVE_STREAM_GATEWAY');
  const probe = providers.find((candidate) => candidate.provide?.description === 'LIVE_SOURCE_PROBE');
  return {
    egress: create('STREAM_EGRESS'),
    sandbox: create('STREAM_SANDBOX'),
    gatewayInjectsRuntime: gateway?.inject?.some((token) => token.description === 'RTSP_STREAM_RUNTIME'),
    probeCoordinator: probe?.useExisting?.description,
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
  }, 15_000);

  it('keeps both privileged runtime ports unavailable in stub mode', async () => {
    const adapters = await runtimeAdapters('stub');
    expect(adapters.egress?.constructor.name).toBe('UnavailableStreamEgressAdapter');
    expect(adapters.sandbox?.constructor.name).toBe('UnavailableStreamSandboxAdapter');
    expect(adapters.gatewayInjectsRuntime).toBe(true);
  }, 15_000);
});
