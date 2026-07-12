import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';
import type { AdminAlertPort } from '../../../src/camera/domain/ports/admin-alert.port';
import type { LiveStreamGatewayPort } from '../../../src/camera/domain/ports/live-stream-gateway.port';
import type { LiveStreamLeasePort } from '../../../src/camera/domain/ports/live-stream-lease.port';
import type { MonotonicClockPort } from '../../../src/camera/domain/ports/monotonic-clock.port';
import {
  createLiveStreamProcessId,
  type LiveStreamLease,
  type LiveStreamSource,
} from '../../../src/camera/domain/live-stream.entity';

describe('LiveStreamSessionService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not extend the deadline when another user joins', async () => {
    const clock = new FakeMonotonicClock(1_000);
    const service = createService({ clock });

    const first = await service.open(source('front_door'), 1);
    clock.advance(120_000);
    const second = await service.open(source('front_door'), 2);

    expect(second.remainingMs).toBe(180_000);
    expect(second.expiresMonotonicMs).toBe(first.expiresMonotonicMs);
  });

  it('cancels a pending start when stop wins the transition queue', async () => {
    const gateway = new DeferredGateway();
    const service = createService({ gateway });

    const opening = service.open(source('front_door'), 1);
    await service.stop(2);
    gateway.resolveStart();

    await expect(opening).rejects.toMatchObject({ code: 'LIVE_STREAM_UNAVAILABLE' });
    expect(gateway.stopCalls).toBe(1);
  });

  it('rejects a stalled pending open promptly when stop wins', async () => {
    const gateway = new DeferredGateway();
    const service = createService({ gateway });

    const opening = service.open(source('front_door'), 1);
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));

    await expect(service.stop(2)).resolves.toBeNull();
    await expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.stopCalls).toBe(0);

    gateway.resolveStart();
    await vi.waitFor(() => expect(gateway.stopCalls).toBe(1));
  });

  it('settles pending and replacement opens when cancellation teardown fails', async () => {
    const gateway = new DeferredGateway();
    gateway.stopError = new Error('stop failed');
    const service = createService({ gateway });

    const first = service.open(source('front_door'), 1);
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));
    const replacement = service.open(source('garden'), 2);
    await service.stop(3);
    gateway.resolveStart();

    const outcomes = await Promise.allSettled([first, replacement]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'LIVE_STREAM_UNAVAILABLE' }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'LIVE_STREAM_UNAVAILABLE' }),
      }),
    ]);
    await vi.waitFor(() => expect(gateway.stopCalls).toBe(1));
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('joins a pending start for the same camera', async () => {
    const gateway = new DeferredGateway();
    const service = createService({ gateway });

    const first = service.open(source('front_door'), 1);
    const second = service.open(source('front_door'), 2);
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));
    gateway.resolveStart();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('starts the requested replacement after a pending camera switch stops', async () => {
    const gateway = new DeferredGateway();
    const service = createService({ gateway });

    const opening = service.open(source('front_door'), 1);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));
    const switching = service.open(source('garden'), 2);
    gateway.resolveStart();
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(2));
    gateway.resolveStart();

    await openingRejected;
    await expect(switching).resolves.toMatchObject({ cameraName: 'garden' });
    expect(gateway.stopCalls).toBe(1);
  });

  it('stops the active session before switching cameras', async () => {
    const gateway = new FakeGateway();
    const service = createService({ gateway });

    await service.open(source('front_door'), 1);
    const switched = await service.open(source('garden'), 2);

    expect(gateway.stopCalls).toBe(1);
    expect(gateway.startCalls).toHaveLength(2);
    expect(switched.cameraName).toBe('garden');
  });

  it('rejects a camera switch with a domain error and retries cleanup after gateway stop fails', async () => {
    const gateway = new FakeGateway();
    gateway.stopError = new Error('stop failed');
    const service = createService({ gateway });

    await service.open(source('front_door'), 1);

    await expect(service.open(source('garden'), 2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    expect(gateway.startCalls).toHaveLength(1);
    expect(gateway.stopCalls).toBe(1);

    gateway.stopError = undefined;

    await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
      cameraName: 'garden',
    });
    expect(gateway.startCalls).toHaveLength(2);
    expect(gateway.stopCalls).toBe(2);
  });

  it('rejects a camera switch with a domain error when lease clear fails', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const service = createService({ gateway, lease });

    await service.open(source('front_door'), 1);
    lease.clearError = new Error('lease clear failed');

    await expect(service.open(source('garden'), 2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    expect(gateway.startCalls).toHaveLength(1);
    expect(gateway.stopCalls).toBe(1);

    lease.clearError = undefined;

    await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
      cameraName: 'garden',
    });
    expect(gateway.startCalls).toHaveLength(2);
    expect(gateway.stopCalls).toBe(1);
  });

  it('maps a gateway stop failure to a domain error', async () => {
    const gateway = new FakeGateway();
    const service = createService({ gateway });

    await service.open(source('front_door'), 1);
    gateway.stopError = new Error('stop failed');

    await expect(service.stop(2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
  });

  it('maps a lease-clear stop failure to a domain error', async () => {
    const lease = new FakeLease();
    const service = createService({ lease });

    await service.open(source('front_door'), 1);
    lease.clearError = new Error('lease clear failed');

    await expect(service.stop(2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
  });

  it('cleans up and rejects every pending caller when writing the lease fails', async () => {
    const gateway = new DeferredGateway();
    const lease = new FakeLease();
    lease.writeError = new Error('lease write failed');
    const service = createService({ gateway, lease });

    const first = service.open(source('front_door'), 1);
    const second = service.open(source('front_door'), 2);
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));
    gateway.resolveStart();

    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'LIVE_STREAM_UNAVAILABLE' }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'LIVE_STREAM_UNAVAILABLE' }),
      }),
    ]);
    expect(gateway.stopCalls).toBe(1);
    await vi.waitFor(() => expect(lease.clearCalls).toBe(1));
  });

  it('cleans up and rejects every pending caller when adding a viewer fails', async () => {
    const gateway = new DeferredGateway();
    gateway.addViewerError = new Error('viewer add failed');
    const lease = new FakeLease();
    const service = createService({ gateway, lease });

    const first = service.open(source('front_door'), 1);
    const second = service.open(source('front_door'), 2);
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));
    gateway.resolveStart();

    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'LIVE_STREAM_UNAVAILABLE' }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'LIVE_STREAM_UNAVAILABLE' }),
      }),
    ]);
    expect(gateway.stopCalls).toBe(1);
    await vi.waitFor(() => expect(lease.clearCalls).toBe(1));
  });

  it('revokes every viewer token issued to a user', async () => {
    const gateway = new FakeGateway();
    const service = createService({ gateway });

    await service.open(source('front_door'), 1);
    await service.open(source('front_door'), 1);
    await service.revokeUser(1);

    expect(gateway.revoked).toHaveLength(2);
  });

  it('maps a gateway revoke failure to a domain error', async () => {
    const gateway = new FakeGateway();
    gateway.revokeError = new Error('revoke failed');
    const service = createService({ gateway });

    await service.open(source('front_door'), 1);

    await expect(service.revokeUser(1)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
  });

  it('persists a watch-message reference after the handler reply', async () => {
    const lease = new FakeLease();
    const service = createService({ lease });
    const opened = await service.open(source('front_door'), 1);

    await opened.registerMessageReference({ chatId: 42, messageId: 9 });

    expect(lease.writes.at(-1)?.messageReferences).toEqual([
      { chatId: 42, messageId: 9 },
    ]);
  });

  it('maps a message-reference lease write failure to a domain error', async () => {
    const lease = new FakeLease();
    const service = createService({ lease });
    const opened = await service.open(source('front_door'), 1);
    lease.writeError = new Error('lease write failed');

    await expect(
      opened.registerMessageReference({ chatId: 42, messageId: 9 }),
    ).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
  });

  it('rejects a hung gateway start at the operation timeout and blocks duplicates', async () => {
    vi.useFakeTimers();
    const gateway = new DeferredGateway();
    const service = createService({ gateway, operationTimeoutMs: 100 });
    const opening = service.open(source('front_door'), 1);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);

    await openingRejected;
    await expect(service.open(source('front_door'), 2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('times out initial viewer provisioning and retains the cleanup blocker', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.hangAddViewer = true;
    gateway.hangStop = true;
    const service = createService({ gateway, operationTimeoutMs: 100 });
    const opening = service.open(source('front_door'), 1);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);

    await openingRejected;
    expect(gateway.stopCalls).toBe(1);
    await expect(service.stop(2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await expect(service.open(source('garden'), 3)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('rejects a hung gateway stop at the operation timeout and blocks replacements', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const service = createService({ gateway, operationTimeoutMs: 100 });
    await service.open(source('front_door'), 1);
    gateway.hangStop = true;
    const stopping = service.stop(2);
    const stoppingRejected = expect(stopping).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);

    await stoppingRejected;
    await expect(service.open(source('garden'), 3)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('rejects a same-camera open after stop cancels a pending hung start', async () => {
    const gateway = new DeferredGateway();
    const service = createService({ gateway });
    const opening = service.open(source('front_door'), 1);
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));

    await expect(service.stop(2)).resolves.toBeNull();

    await expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await expect(service.open(source('front_door'), 3)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('rejects provisioning callers without waiting for a hung teardown', async () => {
    const gateway = new FakeGateway();
    gateway.addViewerError = new Error('viewer add failed');
    gateway.hangStop = true;
    const service = createService({ gateway, operationTimeoutMs: 100 });

    await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await expect(service.open(source('garden'), 2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('stops and clears an expired session through the transition queue', async () => {
    vi.useFakeTimers();
    const clock = new FakeMonotonicClock(1_000);
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const service = createService({ clock, gateway, lease, durationMs: 100 });

    await service.open(source('front_door'), 1);
    clock.advance(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(gateway.stopCalls).toBe(1);
    expect(lease.clearCalls).toBe(1);
  });

  it('keeps an expired session safely retained and retries cleanup after timer teardown fails', async () => {
    vi.useFakeTimers();
    const clock = new FakeMonotonicClock(1_000);
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const service = createService({ clock, gateway, lease, durationMs: 100 });

    await service.open(source('front_door'), 1);
    gateway.stopError = new Error('stop failed');
    clock.advance(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(gateway.stopCalls).toBe(1);
    expect(lease.clearCalls).toBe(0);

    gateway.stopError = undefined;

    await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
      cameraName: 'garden',
    });
    expect(gateway.stopCalls).toBe(2);
    expect(lease.clearCalls).toBe(1);
  });

  it('recovers only a matching owned stale process at boot', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease({
      sessionNonce: 'stale',
      pid: createLiveStreamProcessId(123),
      processIdentity: 'owned-process',
      cameraId: 'front_door',
      diagnosticExpiresAtUnixMs: 0,
      messageReferences: [],
    });
    const service = createService({ gateway, lease });

    await service.onModuleInit();

    expect(gateway.recoveryCalls).toEqual([
      { pid: createLiveStreamProcessId(123), processIdentity: 'owned-process' },
    ]);
    expect(lease.clearCalls).toBe(1);
  });

  it('raises a sanitized alert without stopping an unowned stale process', async () => {
    const gateway = new FakeGateway();
    gateway.recoveryResult = 'not-owned';
    const lease = new FakeLease({
      sessionNonce: 'stale',
      pid: createLiveStreamProcessId(123),
      processIdentity: 'other-process',
      cameraId: 'front_door',
      diagnosticExpiresAtUnixMs: 0,
      messageReferences: [],
    });
    const alerts = new FakeAdminAlert();
    const service = createService({ gateway, lease, alerts });

    await service.onModuleInit();

    expect(gateway.stopCalls).toBe(0);
    expect(alerts.alerts).toEqual([['live-stream-recovery-failed', undefined]]);
    expect(lease.clearCalls).toBe(1);
  });

  it('contains a recovery lease-clear failure behind a sanitized alert', async () => {
    const lease = new FakeLease({
      sessionNonce: 'stale',
      pid: createLiveStreamProcessId(123),
      processIdentity: 'owned-process',
      cameraId: 'front_door',
      diagnosticExpiresAtUnixMs: 0,
      messageReferences: [],
    });
    lease.clearError = new Error('lease clear failed');
    const alerts = new FakeAdminAlert();
    const service = createService({ lease, alerts });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(alerts.alerts).toEqual([['live-stream-recovery-failed', undefined]]);
  });

  it('settles a synchronous gateway start failure and preserves queue usability', async () => {
    const gateway = new FakeGateway();
    gateway.throwStartSynchronously = true;
    const service = createService({ gateway });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
        code: 'LIVE_STREAM_UNAVAILABLE',
      });

      gateway.throwStartSynchronously = false;

      await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
        cameraName: 'garden',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

function source(cameraName: string): LiveStreamSource {
  return {
    kind: 'motion-mjpeg',
    cameraId: cameraName,
    cameraName,
    upstreamUrl: 'http://127.0.0.1:8081/?action=stream',
  };
}

function createService(input: {
  clock?: FakeMonotonicClock;
  gateway?: FakeGateway;
  lease?: FakeLease;
  alerts?: FakeAdminAlert;
  durationMs?: number;
  operationTimeoutMs?: number;
} = {}): LiveStreamSessionService {
  return new LiveStreamSessionService(
    input.gateway ?? new FakeGateway(),
    input.lease ?? new FakeLease(),
    input.clock ?? new FakeMonotonicClock(1_000),
    input.alerts ?? new FakeAdminAlert(),
    input.durationMs ?? 300_000,
    input.operationTimeoutMs ?? 30_000,
  );
}

class FakeMonotonicClock implements MonotonicClockPort {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

class FakeGateway implements LiveStreamGatewayPort {
  startCalls: Array<{ source: LiveStreamSource }> = [];
  revoked: string[] = [];
  recoveryCalls: Array<{ pid: ReturnType<typeof createLiveStreamProcessId>; processIdentity: string }> = [];
  stopCalls = 0;
  recoveryResult: 'stopped' | 'not-owned' = 'stopped';
  stopError?: Error;
  addViewerError?: Error;
  revokeError?: Error;
  hangAddViewer = false;
  hangStop = false;
  throwStartSynchronously = false;

  start(input: { source: LiveStreamSource }): Promise<{
    publicHostname: string;
    pid: ReturnType<typeof createLiveStreamProcessId>;
    processIdentity: string;
  }> {
    this.startCalls.push({ source: input.source });
    if (this.throwStartSynchronously) throw new Error('start failed synchronously');
    return Promise.resolve({
      publicHostname: 'clear-moon.trycloudflare.com',
      pid: createLiveStreamProcessId(123),
      processIdentity: 'owned-process',
    });
  }

  async addViewer(): Promise<void> {
    if (this.addViewerError) throw this.addViewerError;
    if (this.hangAddViewer) await new Promise<never>(() => undefined);
  }

  async revokeViewer(tokenHash: string): Promise<void> {
    if (this.revokeError) throw this.revokeError;
    this.revoked.push(tokenHash);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopError) throw this.stopError;
    if (this.hangStop) await new Promise<never>(() => undefined);
  }

  async recoverOwnedProcess(input: {
    pid: ReturnType<typeof createLiveStreamProcessId>;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'> {
    this.recoveryCalls.push(input);
    return this.recoveryResult;
  }
}

class DeferredGateway extends FakeGateway {
  private readonly resolvers: Array<() => void> = [];

  override async start(input: { source: LiveStreamSource }): Promise<{
    publicHostname: string;
    pid: ReturnType<typeof createLiveStreamProcessId>;
    processIdentity: string;
  }> {
    this.startCalls.push({ source: input.source });
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
    return {
      publicHostname: 'clear-moon.trycloudflare.com',
      pid: createLiveStreamProcessId(123),
      processIdentity: 'owned-process',
    };
  }

  resolveStart(): void {
    this.resolvers.shift()?.();
  }
}

class FakeLease implements LiveStreamLeasePort {
  writes: LiveStreamLease[] = [];
  clearCalls = 0;
  writeError?: Error;
  clearError?: Error;

  constructor(private lease: LiveStreamLease | null = null) {}

  async read(): Promise<LiveStreamLease | null> {
    return this.lease;
  }

  async write(lease: LiveStreamLease): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.lease = lease;
    this.writes.push(lease);
  }

  async clear(): Promise<void> {
    if (this.clearError) throw this.clearError;
    this.lease = null;
    this.clearCalls += 1;
  }
}

class FakeAdminAlert implements AdminAlertPort {
  alerts: Array<[string, string | undefined]> = [];

  async alert(kind: Parameters<AdminAlertPort['alert']>[0], detail?: string): Promise<void> {
    this.alerts.push([kind, detail]);
  }
}
