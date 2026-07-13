import { describe, expect, it, vi } from 'vitest';
import { LiveSource } from '../../../src/camera/domain/live-source.entity';
import type { StreamEgressPort } from '../../../src/camera/domain/ports/stream-egress.port';
import {
  BoundedJpegFrameTracker,
  FfmpegLiveSourceProbeAdapter,
} from '../../../src/camera/infrastructure/ffmpeg-live-source-probe.adapter';

const lease = { sessionId: '123e4567-e89b-42d3-a456-426614174000', leaseId: 'lease-1' };

function fixture(addresses = [{ address: '192.168.1.20', family: 4 as const }]) {
  const egress: StreamEgressPort = {
    grant: vi.fn().mockResolvedValue(lease),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  const execute = vi.fn().mockResolvedValue(undefined);
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
      timeoutMs: 30_000,
      udpPortFirst: 24_000,
      udpPortLast: 24_001,
    },
    {
      lookup,
      execute,
      openUnixSink,
      now: () => 1_800_000_000_000,
      randomUUID: () => lease.sessionId,
      randomBytes: () => Buffer.alloc(32, 7),
    },
  );
  return { adapter, egress, execute, openUnixSink, lookup };
}

describe('FfmpegLiveSourceProbeAdapter', () => {
  it('resolves all answers, grants only the exact validated literals, and uses fixed live-equivalent argv', async () => {
    const { adapter, egress, execute } = fixture([
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
    expect(execute).toHaveBeenCalledOnce();
    const [file, argv, options] = execute.mock.calls[0];
    expect(file).toBe('ffmpeg');
    expect(argv).toEqual(expect.arrayContaining([
      '-protocol_whitelist', 'rtp,rtsp,tcp,tls,udp,unix',
      '-rtsp_transport', 'udp', '-map', '0:v:0', '-an',
      '-vf', 'fps=10,scale=320:-2', '-c:v', 'mjpeg', '-q:v', '5',
      '-frames:v', '1', '-flush_packets', '1', '-f', 'image2pipe',
    ]));
    expect(argv.at(-1)).toMatch(/^unix:\/\/\/tmp\/home-worker-live-source-probe\/probe-[0-9a-f-]+\.sock$/u);
    expect(options).toEqual({ timeout: 30_000, maxBuffer: 65_536, shell: false });
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
    const { adapter, egress, execute } = fixture();
    execute.mockRejectedValueOnce(new Error('raw stderr rtsp://user:pass@cam.local/private'));

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
    const { adapter, egress, execute, lookup } = fixture();
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
    const argv = execute.mock.calls[0][1];
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
    const { adapter, egress, execute } = fixture();
    await adapter.run(LiveSource.create({
      cameraId: 'front_door',
      url: 'rtsp://cam.local/live',
      transport: 'auto',
    }));
    expect(egress.grant).toHaveBeenCalledWith(
      expect.objectContaining({ transport: { kind: 'tcp' } }),
    );
    expect(execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-rtsp_transport', 'tcp']),
    );
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
