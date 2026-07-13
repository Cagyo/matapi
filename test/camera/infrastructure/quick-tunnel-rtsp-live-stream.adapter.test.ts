import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { get as httpGet } from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveStreamSession } from '../../../src/camera/domain/live-stream.entity';
import type { RtspStreamRuntimePort } from '../../../src/camera/domain/ports/rtsp-stream-runtime.port';
import { QuickTunnelLiveStreamAdapter, type CloudflaredChild } from '../../../src/camera/infrastructure/quick-tunnel-live-stream.adapter';
import type { QuickTunnelLiveStreamDependencies } from '../../../src/camera/infrastructure/quick-tunnel-live-stream.adapter';

const SESSION = '01901f4c-b7f4-4c6a-a787-3f8a442c85d2';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function child(): CloudflaredChild {
  const value = new EventEmitter() as CloudflaredChild;
  value.pid = 4321;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = vi.fn(() => true);
  return value;
}

async function fixture(
  runtimeStart: RtspStreamRuntimePort['start'],
  timeout = 1_000,
  overrides: Partial<QuickTunnelLiveStreamDependencies> = {},
) {
  const root = await mkdtemp('/tmp/quick-rtsp-');
  roots.push(root);
  const output = join(root, 'output');
  await mkdir(output);
  const cloudflared = child();
  const runtime: RtspStreamRuntimePort = {
    start: vi.fn(runtimeStart),
    recover: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = new QuickTunnelLiveStreamAdapter({
    rtspRuntime: runtime,
    rtspSocketDirectory: output,
    inspectRtspDirectory: vi.fn().mockResolvedValue(undefined),
    inspectRtspSocket: vi.fn().mockResolvedValue(undefined),
    startupTimeoutMs: timeout,
    stopGraceMs: 0,
    workerProcessGroupId: 99,
    identifyProcess: vi.fn(async () => 'cloud-id'),
    processGroupId: vi.fn(async () => 4321),
    signalProcessGroup: vi.fn(() => true),
    spawnCloudflared: vi.fn(() => {
      queueMicrotask(() => { cloudflared.stderr.write('https://rtsp-live.trycloudflare.com\n'); });
      return cloudflared;
    }),
    publicProbe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  const session = createLiveStreamSession({
    id: SESSION, cameraId: 'cam-1', cameraName: 'Door',
    startedMonotonicMs: 1, durationMs: 30_000,
  });
  return { adapter, runtime, output, session };
}

function connectAndWrite(path: string, chunks: Buffer[]): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => {
      for (const chunk of chunks) socket.write(chunk);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

describe('QuickTunnelLiveStreamAdapter RTSP data plane', () => {
  it('uses one entry budget and fixed expiry across delayed UDS, runtime, frame, and cleanup', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
    try {
      const entryWall = 1_800_000_000_000;
      let resolveCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve; });
      const stop = vi.fn(() => cleanup);
      let runtimeInput: Parameters<RtspStreamRuntimePort['start']>[0] | undefined;
      let runtimeStarts = 0;
      const { adapter, runtime, session } = await fixture(async (input) => {
        runtimeStarts += 1;
        if (runtimeStarts > 1) throw new Error('second start rejected');
        runtimeInput = input;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { processIdentity: 'pid:4:start:5', stop };
      }, 1_000, {
        wallNow: () => entryWall + Date.now(),
        monotonicNow: () => Date.now(),
        inspectRtspDirectory: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 200))),
      });
      let outcome = 'pending';
      void adapter.start({
        session,
        source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' },
      }).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );

      await vi.advanceTimersByTimeAsync(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(499);
      expect(outcome).toBe('pending');
      expect(runtimeInput).toMatchObject({
        expiresAtUnixMs: entryWall + 30_000,
        deadlineMonotonicMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome).toBe('pending');
      expect(stop).toHaveBeenCalledWith(1_000);
      const nextStart = adapter.start({
        session,
        source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' },
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.start).toHaveBeenCalledTimes(1);

      resolveCleanup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10);
      await nextStart;
      expect(outcome).toBe('rejected');
      expect(runtime.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the listener but fences lifecycle while runtime startup never settles', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
    try {
      const { adapter, runtime, output, session } = await fixture(
        () => new Promise(() => undefined),
        1_000,
        { wallNow: () => 1_800_000_000_000 + Date.now(), monotonicNow: () => Date.now() },
      );
      let outcome = 'pending';
      void adapter.start({
        session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' },
      }).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      for (let attempt = 0; attempt < 5 && vi.mocked(runtime.start).mock.calls.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(runtime.start).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toBe('pending');
      await expect(access(join(output, `${SESSION}.sock`))).rejects.toMatchObject({ code: 'ENOENT' });
      void adapter.start({
        session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' },
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans a late runtime handle retryably before releasing the lifecycle fence', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
    try {
      const stop = vi.fn()
        .mockRejectedValueOnce(new Error('late stop failed'))
        .mockResolvedValue(undefined);
      let starts = 0;
      const { adapter, runtime, session } = await fixture(async () => {
        starts += 1;
        if (starts > 1) throw new Error('next start rejected');
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return { processIdentity: 'pid:4:start:5', stop };
      }, 1_000, {
        wallNow: () => 1_800_000_000_000 + Date.now(), monotonicNow: () => Date.now(),
      });
      let outcome = 'pending';
      void adapter.start({
        session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' },
      }).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      for (let attempt = 0; attempt < 5 && vi.mocked(runtime.start).mock.calls.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(runtime.start).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      void adapter.start({
        session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' },
      }).catch(() => undefined);
      expect(runtime.start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(10);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10);

      expect(stop).toHaveBeenCalledTimes(2);
      expect(outcome).toBe('rejected');
      expect(runtime.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates the exact socket before runtime start and requires a split JPEG before tunnel readiness', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    let observedPath = '';
    let producer!: Socket;
    const { adapter, runtime, output, session } = await fixture(async (input) => {
      observedPath = input.socketPath;
      await expect(access(input.socketPath)).resolves.toBeUndefined();
      producer = await connectAndWrite(input.socketPath, [Buffer.from([0xff]), Buffer.from([0xd8, 1, 2, 0xff]), Buffer.from([0xd9])]);
      return { processIdentity: 'pid:4:start:5', stop };
    });

    await expect(adapter.start({ session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' } }))
      .resolves.toMatchObject({ publicHostname: 'rtsp-live.trycloudflare.com' });
    expect(observedPath).toBe(join(output, `${SESSION}.sock`));
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ cameraId: 'cam-1', sessionId: SESSION }));

    const token = 'viewer-token-with-enough-entropy';
    await adapter.addViewer({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      telegramId: 1,
      expiresMonotonicMs: Number.MAX_SAFE_INTEGER,
    });
    let markViewerReady!: () => void;
    const viewerReady = new Promise<void>((resolve) => { markViewerReady = resolve; });
    const received = new Promise<Buffer>((resolve, reject) => {
      const request = httpGet(`${adapter.localOrigin}/mjpeg/${token}`, (response) => {
        markViewerReady();
        response.once('data', (chunk: Buffer) => { resolve(chunk); response.destroy(); });
      });
      request.once('error', reject);
    });
    await viewerReady;
    producer.write(Buffer.from([0xff, 0xd8, 9]));
    producer.write(Buffer.from([8, 0xff, 0xd9]));
    await expect(received).resolves.toEqual(expect.objectContaining({ length: expect.any(Number) }));

    await adapter.stop();
    expect(stop).toHaveBeenCalledOnce();
    await expect(access(observedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a second producer and never accepts its fake readiness frame', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { adapter, session } = await fixture(async (input) => {
      await connectAndWrite(input.socketPath, [Buffer.from([0xff, 0xd8, 1])]);
      await connectAndWrite(input.socketPath, [Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9])]);
      return { processIdentity: 'pid:4:start:5', stop };
    }, 100);

    await expect(adapter.start({ session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' } }))
      .rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('fails closed on an oversized incomplete producer frame', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { adapter, session } = await fixture(async (input) => {
      await connectAndWrite(input.socketPath, [Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(2 * 1024 * 1024 + 1)])]);
      return { processIdentity: 'pid:4:start:5', stop };
    });

    await expect(adapter.start({ session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' } }))
      .rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('uses the persisted session UUID during recovery', async () => {
    const unlinkSocket = vi.fn().mockResolvedValue(undefined);
    const { adapter, runtime, output } = await fixture(async () => { throw new Error('unused'); }, 1_000, {
      unlinkRtspSocket: unlinkSocket,
    });
    await adapter.recoverOwnedProcess({ sessionId: SESSION, sourceKind: 'rtsp', pid: 4321 as never, processIdentity: 'cloud-id' });
    expect(runtime.recover).toHaveBeenCalledWith(SESSION);
    expect(unlinkSocket).toHaveBeenCalledWith(join(output, `${SESSION}.sock`));
  });

  it('preserves Motion recovery when the RTSP output directory does not exist', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const { adapter, runtime } = await fixture(async () => { throw new Error('unused'); }, 1_000, {
      inspectRtspDirectory: vi.fn().mockRejectedValue(missing),
    });

    await expect(adapter.recoverOwnedProcess({
      sessionId: SESSION, sourceKind: 'motion-mjpeg', pid: 4321 as never, processIdentity: 'cloud-id',
    })).resolves.toBe('stopped');
    expect(runtime.recover).not.toHaveBeenCalled();
  });

  it('treats a backward-compatible lease without source kind as Motion recovery', async () => {
    const { adapter, runtime } = await fixture(async () => { throw new Error('unused'); });

    await expect(adapter.recoverOwnedProcess({
      sessionId: SESSION, pid: 4321 as never, processIdentity: 'cloud-id',
    } as never)).resolves.toBe('stopped');
    expect(runtime.recover).not.toHaveBeenCalled();
  });

  it('reverses the live lifecycle after a ready producer terminates', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const failure = vi.fn();
    let producer!: Socket;
    const { adapter, session } = await fixture(async (input) => {
      producer = await connectAndWrite(input.socketPath, [Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9])]);
      return { processIdentity: 'pid:4:start:5', stop };
    });
    adapter.onFailure(failure);
    await adapter.start({ session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' } });

    producer.destroy();

    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(failure).toHaveBeenCalledOnce();
    expect(adapter.localOrigin).toBeNull();
  });

  it('retains the exact socket cleanup handle until a failed unlink is retried', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const unlinkSocket = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
      .mockImplementation((path: string) => unlink(path));
    const { adapter, session, output } = await fixture(async (input) => {
      await connectAndWrite(input.socketPath, [Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9])]);
      return { processIdentity: 'pid:4:start:5', stop };
    }, 1_000, { unlinkRtspSocket: unlinkSocket });
    await adapter.start({ session, source: { kind: 'rtsp', cameraId: 'cam-1', cameraName: 'Door' } });

    await expect(adapter.stop()).rejects.toThrow('cleanup incomplete');
    await expect(access(join(output, `${SESSION}.sock`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(unlinkSocket).toHaveBeenCalledTimes(2);
  });

  it('attempts cloudflared recovery even when exact RTSP recovery fails', async () => {
    const signal = vi.fn(() => true);
    const { adapter, runtime } = await fixture(async () => { throw new Error('unused'); }, 1_000, {
      signalProcessGroup: signal,
    });
    vi.mocked(runtime.recover).mockRejectedValueOnce(new Error('systemd unavailable'));

    await expect(adapter.recoverOwnedProcess({ sessionId: SESSION, sourceKind: 'rtsp', pid: 4321 as never, processIdentity: 'cloud-id' }))
      .rejects.toThrow('recovery incomplete');
    expect(signal).toHaveBeenCalledWith(4321, 'SIGTERM');
  });
});
