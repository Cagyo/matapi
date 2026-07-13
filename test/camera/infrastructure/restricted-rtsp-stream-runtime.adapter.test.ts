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

  it('bounds credential loading by the gateway deadline and never starts late', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const source = LiveSource.create({ cameraId: 'cam-1', url: 'rtsp://camera.local/live' });
      const loadForStream = vi.fn(() => new Promise<{ source: LiveSource; credential: ReturnType<LiveSource['credentialPayload']> }>((resolve) => {
        setTimeout(() => resolve({ source, credential: source.credentialPayload() }), 1_001);
      }));
      const startRestrictedRuntime = vi.fn();
      const adapter = new RestrictedRtspStreamRuntimeAdapter(
        { loadForStream } as unknown as LiveSourceRepositoryPort,
        { startRestrictedRuntime, recoverRestrictedRuntime: vi.fn() },
        () => Date.now(),
      );
      let outcome = 'pending';
      void adapter.start({
        cameraId: 'cam-1', sessionId: SESSION, socketPath: '/run/output.sock',
        expiresAtUnixMs: 30_000, deadlineMonotonicMs: 1_000,
      }).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome).toBe('rejected');
      expect(startRestrictedRuntime).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(startRestrictedRuntime).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
