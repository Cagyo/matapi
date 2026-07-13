import { describe, expect, it, vi } from 'vitest';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';
import type { RtspRuntimeCoordinatorPort } from '../../../src/camera/domain/ports/rtsp-runtime-coordinator.port';
import { RestrictedRtspStreamRuntimeAdapter } from '../../../src/camera/infrastructure/restricted-rtsp-stream-runtime.adapter';

const SESSION = '01901f4c-b7f4-4c6a-a787-3f8a442c85d2';

describe('RestrictedRtspStreamRuntimeAdapter', () => {
  it('loads plaintext only at start and returns only an opaque runtime handle', async () => {
    const source = LiveSource.create({ cameraId: 'cam-1', url: 'rtsps://user:pass@camera.local/live', tlsMode: 'strict' });
    const loadForStream = vi.fn(async () => ({ source, credential: source.credentialPayload() }));
    const stop = vi.fn().mockResolvedValue(undefined);
    const startRestrictedRuntime = vi.fn(async () => ({ processIdentity: 'pid:4:start:5', stop }));
    const coordinator: RtspRuntimeCoordinatorPort = {
      startRestrictedRuntime,
      recoverRestrictedRuntime: vi.fn(),
    };
    const adapter = new RestrictedRtspStreamRuntimeAdapter(
      { loadForStream } as unknown as LiveSourceRepositoryPort,
      coordinator,
    );
    expect(loadForStream).not.toHaveBeenCalled();

    const handle = await adapter.start({
      cameraId: 'cam-1', sessionId: SESSION,
      socketPath: `/run/home-worker/live-stream-output/${SESSION}.sock`,
      expiresAtUnixMs: Date.now() + 30_000,
    });

    expect(loadForStream).toHaveBeenCalledOnce();
    expect(startRestrictedRuntime).toHaveBeenCalledWith(source, expect.objectContaining({ sessionId: SESSION }));
    expect(handle).toEqual({ processIdentity: 'pid:4:start:5', stop });
    expect(JSON.stringify(handle)).not.toMatch(/camera\.local|user|pass/i);
  });

  it('uses the persisted session UUID for bounded sandbox recovery', async () => {
    const recoverRestrictedRuntime = vi.fn().mockResolvedValue(undefined);
    const adapter = new RestrictedRtspStreamRuntimeAdapter(
      {} as LiveSourceRepositoryPort,
      { recoverRestrictedRuntime } as unknown as RtspRuntimeCoordinatorPort,
    );
    await adapter.recover(SESSION);
    expect(recoverRestrictedRuntime).toHaveBeenCalledWith(SESSION);
  });

  it('sanitizes repository and coordinator failures', async () => {
    const adapter = new RestrictedRtspStreamRuntimeAdapter(
      { loadForStream: vi.fn(async () => { throw new Error('rtsp://user:pass@camera/private'); }) } as unknown as LiveSourceRepositoryPort,
      {} as RtspRuntimeCoordinatorPort,
    );
    await expect(adapter.start({ cameraId: 'cam', sessionId: SESSION, socketPath: '/secret', expiresAtUnixMs: Date.now() + 1_000 }))
      .rejects.toMatchObject({ message: 'Live source probe failed' });
  });
});
