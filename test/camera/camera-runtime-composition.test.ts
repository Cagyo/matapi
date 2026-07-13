import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Provider { provide?: { description?: string }; useFactory?: () => unknown }

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
  return { egress: create('STREAM_EGRESS'), sandbox: create('STREAM_SANDBOX') };
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
  }, 15_000);

  it('keeps both privileged runtime ports unavailable in stub mode', async () => {
    const adapters = await runtimeAdapters('stub');
    expect(adapters.egress?.constructor.name).toBe('UnavailableStreamEgressAdapter');
    expect(adapters.sandbox?.constructor.name).toBe('UnavailableStreamSandboxAdapter');
  }, 15_000);
});
