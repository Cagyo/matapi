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
