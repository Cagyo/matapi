import { access, mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { StreamEgressPort } from '../../../src/camera/domain/ports/stream-egress.port';
import {
  BoundedJpegFrameTracker,
  FfmpegLiveSourceProbeAdapter,
  openFfmpegProbeUnixSink,
  startFfmpegProbeProcess,
} from '../../../src/camera/infrastructure/ffmpeg-live-source-probe.adapter';

const lease = { sessionId: '123e4567-e89b-42d3-a456-426614174000', leaseId: 'lease-1' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('child readiness marker was not created');
}

function fixture(
  addresses = [{ address: '192.168.1.20', family: 4 as const }],
  timeoutMs = 30_000,
) {
  const egress: StreamEgressPort = {
    grant: vi.fn().mockResolvedValue(lease),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  const processHandle = {
    completion: Promise.resolve(),
    kill: vi.fn(),
  };
  const startProcess = vi.fn(() => processHandle);
  const openUnixSink = vi.fn().mockResolvedValue({
    confirmFrame: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const lookup = vi.fn().mockResolvedValue(addresses);
  const adapter = new FfmpegLiveSourceProbeAdapter(
    egress,
    {
      allowedCidrs: '192.168.0.0/16,fd00::/8',
      runtimeDirectory: '/tmp/home-worker-live-source-probe',
      timeoutMs,
      udpPortFirst: 24_000,
      udpPortLast: 24_001,
    },
    {
      lookup,
      startProcess,
      openUnixSink,
      now: () => 1_800_000_000_000,
      wallNow: () => 1_800_000_000_000,
      monotonicNow: () => Date.now(),
      randomUUID: () => lease.sessionId,
      randomBytes: () => Buffer.alloc(32, 7),
    } as never,
  );
  return {
    adapter,
    egress,
    startProcess,
    processHandle,
    openUnixSink,
    lookup,
  };
}

describe('FfmpegLiveSourceProbeAdapter', () => {
  it('resolves all answers, grants only the exact validated literals, and uses fixed live-equivalent argv', async () => {
    const { adapter, egress, startProcess } = fixture([
      { address: '192.168.1.20', family: 4 },
      { address: 'fd00::20', family: 6 },
    ]);
    const source = LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://user:pass@cam.local/private?token=secret',
      transport: 'udp',
      profile: 'eco',
      ready: true,
    });

    await adapter.run(source);

    expect(egress.grant).toHaveBeenCalledWith(expect.objectContaining({
      addresses: [
        { family: 'ipv4', address: '192.168.1.20' },
        { family: 'ipv6', address: 'fd00::20' },
      ],
      rtspControlPorts: [554],
      transport: { kind: 'udp', udpMediaPorts: { first: 24_000, last: 24_001 } },
    }));
    expect(startProcess).toHaveBeenCalledOnce();
    const [file, argv, options] = startProcess.mock.calls[0];
    expect(file).toBe('ffmpeg');
    expect(argv).toEqual(expect.arrayContaining([
      '-protocol_whitelist', 'rtp,rtsp,tcp,tls,udp,unix',
      '-rtsp_transport', 'udp', '-map', '0:v:0', '-an',
      '-vf', 'fps=10,scale=320:-2', '-c:v', 'mjpeg', '-q:v', '5',
      '-frames:v', '1', '-flush_packets', '1', '-f', 'image2pipe',
    ]));
    expect(argv.at(-1)).toMatch(/^unix:\/\/\/tmp\/home-worker-live-source-probe\/probe-[0-9a-f-]+\.sock$/u);
    expect(options).toEqual({ maxBuffer: 65_536, shell: false });
    expect(egress.revoke).toHaveBeenCalledWith(lease);
  });

  it('rejects empty or mixed DNS answers outside the CIDR before grant', async () => {
    for (const addresses of [
      [],
      [
        { address: '192.168.1.20', family: 4 as const },
        { address: '203.0.113.10', family: 4 as const },
      ],
    ]) {
      const { adapter, egress } = fixture(addresses);
      await expect(adapter.run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' })))
        .rejects.toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
      expect(egress.grant).not.toHaveBeenCalled();
    }
  });

  it('always revokes after spawn failure and redacts the source and child error', async () => {
    const { adapter, egress, startProcess } = fixture();
    startProcess.mockImplementationOnce(() => ({
      completion: Promise.reject(
        new Error('raw stderr rtsp://user:pass@cam.local/private'),
      ),
      kill: vi.fn(),
    }));

    try {
      await adapter.run(LiveSource.create({
        cameraId: 'front_door',
        url: 'rtsp://user:pass@cam.local/private',
      }));
      expect.unreachable('expected probe failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
      expect(JSON.stringify(error)).not.toMatch(/user|pass|private|stderr/i);
    }
    expect(egress.revoke).toHaveBeenCalledWith(lease);
  });

  it('rejects an exit-zero probe that delivered no complete JPEG frame', async () => {
    const { adapter, egress, openUnixSink } = fixture();
    openUnixSink.mockResolvedValueOnce({
      confirmFrame: vi.fn().mockRejectedValue(new Error('empty output')),
      close: vi.fn().mockResolvedValue(undefined),
    });
    await expect(
      adapter.run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' })),
    ).rejects.toMatchObject({ code: 'LIVE_SOURCE_PROBE_FAILED' });
    expect(egress.revoke).toHaveBeenCalledWith(lease);
  });

  it('checks literal IPs without DNS and enforces strict RTSPS hostname verification', async () => {
    const { adapter, egress, startProcess, lookup } = fixture();
    await adapter.run(LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsps://192.168.1.20/live',
      tlsMode: 'strict',
    }));
    expect(egress.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        addresses: [{ family: 'ipv4', address: '192.168.1.20' }],
        rtspControlPorts: [322],
      }),
    );
    const argv = startProcess.mock.calls[0][1];
    expect(argv).toEqual(expect.arrayContaining([
      '-tls_verify', '1', '-verifyhost', '192.168.1.20',
    ]));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('validates both endpoints but grants only the selected substream literals', async () => {
    const { adapter, egress, lookup } = fixture();
    lookup.mockImplementation(async (hostname: string) =>
      hostname === 'main.local'
        ? [{ address: '192.168.1.20', family: 4 }]
        : [{ address: '192.168.1.21', family: 4 }],
    );
    await adapter.run(LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://main.local/live',
      substream: 'rtsp://sub.local/low',
      profile: 'eco',
    }));
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(egress.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        addresses: [{ family: 'ipv4', address: '192.168.1.21' }],
      }),
    );
  });

  it('probes auto transport as a TCP-only egress grant', async () => {
    const { adapter, egress, startProcess } = fixture();
    await adapter.run(LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://cam.local/live',
      transport: 'auto',
    }));
    expect(egress.grant).toHaveBeenCalledWith(
      expect.objectContaining({ transport: { kind: 'tcp' } }),
    );
    expect(startProcess.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-rtsp_transport', 'tcp']),
    );
  });

  it('bounds DNS from run entry with a monotonic hard deadline', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, lookup } = fixture(undefined, 1_000);
      lookup.mockImplementationOnce(() => new Promise(() => undefined));
      let outcome = 'pending';
      void adapter
        .run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' }))
        .then(
          () => { outcome = 'resolved'; },
          () => { outcome = 'rejected'; },
        );

      await vi.advanceTimersByTimeAsync(1_001);

      expect(outcome).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates and reaps an uncooperative child inside the total deadline', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, startProcess, processHandle } = fixture(
        undefined,
        1_000,
      );
      const completion = deferred<void>();
      const signals: NodeJS.Signals[] = [];
      startProcess.mockReturnValueOnce({
        completion: completion.promise,
        kill: vi.fn((signal: NodeJS.Signals) => {
          signals.push(signal);
          if (signal === 'SIGKILL') completion.resolve();
        }),
      });
      let outcome = 'pending';
      void adapter
        .run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' }))
        .then(
          () => { outcome = 'resolved'; },
          () => { outcome = 'rejected'; },
        );

      await vi.advanceTimersByTimeAsync(1_001);

      expect(outcome).toBe('rejected');
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(processHandle.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds slow cleanup and safely revokes a lease that resolves late', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, egress, openUnixSink } = fixture(undefined, 1_000);
      const lateGrant = deferred<typeof lease>();
      vi.mocked(egress.grant).mockReturnValueOnce(lateGrant.promise);
      vi.mocked(egress.revoke).mockImplementation(
        () => new Promise(() => undefined),
      );
      let outcome = 'pending';
      void adapter
        .run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' }))
        .then(
          () => { outcome = 'resolved'; },
          () => { outcome = 'rejected'; },
        );

      await vi.advanceTimersByTimeAsync(1_001);
      expect(outcome).toBe('rejected');

      lateGrant.resolve(lease);
      await Promise.resolve();
      await Promise.resolve();
      expect(egress.revoke).toHaveBeenCalledWith(lease);
      expect(openUnixSink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a sink that resolves after its bounded open stage', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, egress, openUnixSink } = fixture(undefined, 1_000);
      const lateSink = deferred<{
        confirmFrame(timeoutMs: number): Promise<void>;
        close(): Promise<void>;
      }>();
      const close = vi.fn().mockRejectedValue(new Error('late close failed'));
      openUnixSink.mockReturnValueOnce(lateSink.promise);
      let outcome = 'pending';
      void adapter
        .run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' }))
        .then(
          () => { outcome = 'resolved'; },
          () => { outcome = 'rejected'; },
        );

      await vi.advanceTimersByTimeAsync(1_001);
      expect(outcome).toBe('rejected');
      expect(egress.revoke).toHaveBeenCalledWith(lease);

      lateSink.resolve({
        confirmFrame: vi.fn().mockResolvedValue(undefined),
        close,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds frame confirmation, sink close, and lease revoke by one deadline', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, egress, openUnixSink } = fixture(undefined, 1_000);
      const confirmFrame = vi.fn(() => new Promise<void>(() => undefined));
      const close = vi.fn(() => new Promise<void>(() => undefined));
      openUnixSink.mockResolvedValueOnce({ confirmFrame, close });
      vi.mocked(egress.revoke).mockImplementation(
        () => new Promise(() => undefined),
      );
      let outcome = 'pending';
      void adapter
        .run(LiveSource.create({ cameraId: 'c1', url: 'rtsp://cam.local/live' }))
        .then(
          () => { outcome = 'resolved'; },
          () => { outcome = 'rejected'; },
        );

      await vi.advanceTimersByTimeAsync(1_001);

      expect(outcome).toBe('rejected');
      expect(confirmFrame).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(egress.revoke).toHaveBeenCalledWith(lease);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['0.0.0.0/0', '::/0', '192.168.1.1/99', 'not-a-cidr']) (
    'rejects malformed or dangerously broad CIDR configuration: %s',
    (allowedCidrs) => {
      const egress = { grant: vi.fn(), revoke: vi.fn() } as StreamEgressPort;
      expect(() => new FfmpegLiveSourceProbeAdapter(egress, {
        allowedCidrs,
        runtimeDirectory: '/tmp/home-worker-live-source-probe',
        timeoutMs: 30_000,
        udpPortFirst: 24_000,
        udpPortLast: 24_001,
      })).toThrowError(/network policy is invalid/i);
    },
  );
});

describe('BoundedJpegFrameTracker', () => {
  it('accepts one complete JPEG split across chunks', () => {
    const tracker = new BoundedJpegFrameTracker();
    tracker.accept(Uint8Array.from([0xff]));
    tracker.accept(Uint8Array.from([0xd8, 0x01, 0xff]));
    tracker.accept(Uint8Array.from([0xd9]));
    expect(() => tracker.confirm()).not.toThrow();
  });

  it('rejects empty, partial, and over-2-MiB output', () => {
    expect(() => new BoundedJpegFrameTracker().confirm()).toThrow();
    const partial = new BoundedJpegFrameTracker();
    partial.accept(Uint8Array.from([0xff, 0xd8, 0x01]));
    expect(() => partial.confirm()).toThrow();
    const oversized = new BoundedJpegFrameTracker();
    expect(() => oversized.accept(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow();
  });

  it('waits for a delayed final JPEG chunk before confirming', async () => {
    const tracker = new BoundedJpegFrameTracker();
    tracker.accept(Uint8Array.from([0xff, 0xd8, 0x01, 0xff]));
    const confirmation = tracker.waitForFrame(100);
    setTimeout(() => tracker.accept(Uint8Array.from([0xd9])), 5);
    await expect(confirmation).resolves.toBeUndefined();
  });
});

describe('startFfmpegProbeProcess', () => {
  it('maps a real max-buffer overflow to the redacted probe error', async () => {
    const processHandle = startFfmpegProbeProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(70_000))"],
      { maxBuffer: 65_536, shell: false },
    );

    await expect(processHandle.completion).rejects.toMatchObject({
      code: 'LIVE_SOURCE_PROBE_FAILED',
      message: 'Live source probe failed',
    });
  });

  it('retains a real TERM-ignoring child until KILL closes and reaps it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rtsp-probe-child-'));
    const readyPath = join(directory, 'ready');
    const processHandle = startFfmpegProbeProcess(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs'); process.on('SIGTERM',()=>undefined); fs.writeFileSync(process.argv[1],'ready'); setInterval(()=>undefined,1_000)",
        readyPath,
      ],
      { maxBuffer: 65_536, shell: false },
    );
    let settled = false;
    void processHandle.completion.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    try {
      await waitForPath(readyPath);
      processHandle.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);

      processHandle.kill('SIGKILL');
      await expect(processHandle.completion).rejects.toMatchObject({
        code: 'LIVE_SOURCE_PROBE_FAILED',
      });
      expect(settled).toBe(true);
    } finally {
      if (!settled) {
        processHandle.kill('SIGKILL');
        await processHandle.completion.catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('openFfmpegProbeUnixSink', () => {
  it('closes and unlinks a listening sink when post-listen setup fails', async () => {
    const socketPath = '/tmp/rtsp-probe-failure-atomic.sock';
    const destroy = vi.fn();
    const socket = {
      on: vi.fn().mockReturnThis(),
      destroy,
    } as unknown as Socket;
    const unlink = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn((listener: () => void) => listener());
    let listening = false;

    await expect(
      openFfmpegProbeUnixSink(socketPath, {
        mkdir: vi.fn().mockResolvedValue(undefined),
        unlink,
        chmod: async () => {
          throw new Error('chmod failed');
        },
        createServer: (onConnection) => ({
          get listening() {
            return listening;
          },
          once: vi.fn(),
          off: vi.fn(),
          listen: (_path, listener) => {
            listening = true;
            onConnection(socket);
            listener();
          },
          close: (listener) => {
            listening = false;
            close(listener);
          },
        }),
      }),
    ).rejects.toThrow('chmod failed');

    expect(destroy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenLastCalledWith(socketPath);
  });
});
