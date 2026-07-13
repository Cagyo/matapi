import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

  it('starts the full session deadline only after tunnel readiness succeeds', async () => {
    vi.useFakeTimers();
    const clock = new FakeMonotonicClock(1_000);
    const gateway = new DeferredGateway();
    const service = createService({ clock, gateway, durationMs: 100 });

    const opening = service.open(source('front_door'), 1);
    await vi.advanceTimersByTimeAsync(0);
    clock.advance(75);
    gateway.resolveStart();
    await vi.advanceTimersByTimeAsync(0);

    await expect(opening).resolves.toMatchObject({
      remainingMs: 100,
      expiresMonotonicMs: 1_175,
    });

    clock.advance(99);
    await vi.advanceTimersByTimeAsync(99);
    expect(gateway.stopCalls).toBe(0);

    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.stopCalls).toBe(1);
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

  it('clears the active lease when the gateway reports terminal data-plane failure', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const service = createService({ gateway, lease });
    await service.open(source('front_door'), 1);

    gateway.triggerFailure();

    await vi.waitFor(() => expect(gateway.stopCalls).toBe(1));
    expect(lease.current()).toBeNull();
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

  it('rejects a replacement when cancelled-start cleanup times out and never starts it late', async () => {
    vi.useFakeTimers();
    const gateway = new DeferredGateway();
    gateway.deferStop = true;
    const service = createService({ gateway, operationTimeoutMs: 100 });
    const opening = service.open(source('front_door'), 1);
    const replacement = service.open(source('garden'), 2);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    const replacementRejected = expect(replacement).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.startCalls).toHaveLength(1);
    gateway.resolveStart();
    await vi.advanceTimersByTimeAsync(100);

    await openingRejected;
    await replacementRejected;

    gateway.resolveStop();
    await vi.advanceTimersByTimeAsync(0);

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

  it('joins an already queued replacement while cancelled-start teardown is pending', async () => {
    const gateway = new DeferredGateway();
    const service = createService({ gateway });

    const opening = service.open(source('front_door'), 1);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(1));
    const firstReplacement = service.open(source('garden'), 2);
    const secondReplacement = service.open(source('garden'), 3);
    gateway.resolveStart();
    await vi.waitFor(() => expect(gateway.startCalls).toHaveLength(2));
    gateway.resolveStart();

    await openingRejected;
    await expect(Promise.all([firstReplacement, secondReplacement])).resolves.toHaveLength(2);
    expect(gateway.startCalls).toHaveLength(2);
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

  it('fences a timed-out lease clear until it settles before starting a replacement', async () => {
    vi.useFakeTimers();
    const lease = new FakeLease();
    const service = createService({ lease, operationTimeoutMs: 100 });
    await service.open(source('front_door'), 1);
    lease.deferNextClear = true;
    const stopping = service.stop(2);
    const stoppingRejected = expect(stopping).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);

    await stoppingRejected;
    await expect(service.open(source('garden'), 3)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(lease.current()?.cameraId).toBe('front_door');

    lease.resolveClear();
    await vi.advanceTimersByTimeAsync(0);

    await expect(service.open(source('garden'), 3)).resolves.toMatchObject({
      cameraName: 'garden',
    });
    expect(lease.current()?.cameraId).toBe('garden');
  });

  it('fences a timed-out lease clear while retrying blocked provisioning cleanup', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.addViewerError = new Error('viewer add failed');
    gateway.stopError = new Error('stop failed');
    const lease = new FakeLease();
    const service = createService({ gateway, lease, operationTimeoutMs: 100 });

    await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(0);

    gateway.addViewerError = undefined;
    gateway.stopError = undefined;
    lease.deferNextClear = true;
    const replacement = service.open(source('garden'), 2);
    const replacementRejected = expect(replacement).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(200);

    await replacementRejected;
    expect(gateway.startCalls).toHaveLength(1);

    lease.resolveClear();
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
      cameraName: 'garden',
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

  it('replaces a user grant and revokes the previous gateway token hash', async () => {
    const gateway = new FakeGateway();
    const service = createService({ gateway });

    const first = await service.open(source('front_door'), 1);
    const firstToken = first.watchUrl.split('/').at(-1)!;
    const firstHash = createHash('sha256').update(firstToken).digest('hex');
    const second = await service.open(source('front_door'), 1);

    expect(second.watchUrl).not.toBe(first.watchUrl);
    expect(gateway.revoked).toEqual([firstHash]);
  });

  it('keeps the current generation when same-user replies register out of order', async () => {
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ lease, messages });

    const stale = await service.open(source('front_door'), 1);
    const current = await service.open(source('front_door'), 1);
    expect(current.grantId).not.toBe(stale.grantId);

    await current.registerMessageReference({ chatId: 42, messageId: 20 });
    await stale.registerMessageReference({ chatId: 42, messageId: 10 });

    expect(lease.current()?.messageReferences).toEqual([
      { telegramId: 1, chatId: 42, messageId: 20 },
    ]);
    expect(messages.deleted).toContainEqual({
      telegramId: 1,
      chatId: 42,
      messageId: 10,
    });
  });

  it('contains stale-reply deletion failure without revoking the current grant', async () => {
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ lease, messages });
    const stale = await service.open(source('front_door'), 1);
    await service.open(source('front_door'), 1);
    messages.deleteError = new Error('telegram unavailable');

    await expect(
      stale.registerMessageReference({ chatId: 42, messageId: 10 }),
    ).resolves.toBeUndefined();
    expect(lease.current()?.messageReferences).toEqual([]);
    await expect(service.open(source('front_door'), 2)).resolves.toBeDefined();
    await expect(service.open(source('front_door'), 3)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
  });

  it('removes the old reference when replacement add fails after revocation', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, lease, messages });
    const first = await service.open(source('front_door'), 1);
    await first.registerMessageReference({ chatId: 42, messageId: 1 });
    gateway.addViewerError = new Error('replacement add failed');

    await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    expect(lease.current()?.messageReferences).toEqual([]);
    expect(messages.deleted).toContainEqual({
      telegramId: 1,
      chatId: 42,
      messageId: 1,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
        code: 'LIVE_STREAM_UNAVAILABLE',
      });
    }
    gateway.addViewerError = undefined;
    const second = await service.open(source('front_door'), 2);
    await second.registerMessageReference({ chatId: 42, messageId: 2 });
    const third = await service.open(source('front_door'), 3);
    await third.registerMessageReference({ chatId: 42, messageId: 3 });
    expect(lease.current()?.messageReferences).toHaveLength(2);
    await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
  });

  it('tears down the session when revoked-reference persistence fails', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const service = createService({ gateway, lease });
    const first = await service.open(source('front_door'), 1);
    await first.registerMessageReference({ chatId: 42, messageId: 1 });
    lease.writeError = new Error('replacement cleanup write failed');

    await expect(service.open(source('front_door'), 1)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    expect(gateway.stopCalls).toBe(1);
    expect(lease.current()).toBeNull();
  });

  it('rejects a third distinct user without evicting existing grants', async () => {
    const gateway = new FakeGateway();
    const service = createService({ gateway });

    const first = await service.open(source('front_door'), 1);
    const second = await service.open(source('front_door'), 2);

    await expect(service.open(source('front_door'), 3)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.revoked).toEqual([]);
    expect(first.watchUrl).toContain('/watch/');
    expect(second.watchUrl).toContain('/watch/');
  });

  it('releases a revoked user message slot before later users register', async () => {
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ lease, messages });
    const first = await service.open(source('front_door'), 1);
    await first.registerMessageReference({ chatId: 42, messageId: 1 });

    await service.revokeUser(1);
    const second = await service.open(source('front_door'), 2);
    await second.registerMessageReference({ chatId: 42, messageId: 2 });
    const third = await service.open(source('front_door'), 3);
    await third.registerMessageReference({ chatId: 42, messageId: 3 });

    expect(lease.current()?.messageReferences).toEqual([
      { telegramId: 2, chatId: 42, messageId: 2 },
      { telegramId: 3, chatId: 42, messageId: 3 },
    ]);
    expect(messages.deleted).toContainEqual({ telegramId: 1, chatId: 42, messageId: 1 });
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

  it('times out a hung viewer revocation without blocking later transitions', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.hangRevoke = true;
    const service = createService({ gateway, operationTimeoutMs: 100 });

    await service.open(source('front_door'), 1);
    const revoking = service.revokeUser(1);
    const revokingRejected = expect(revoking).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    await revokingRejected;

    await expect(service.open(source('front_door'), 2)).resolves.toMatchObject({
      cameraName: 'front_door',
    });
  });

  it('persists a watch-message reference after the handler reply', async () => {
    const lease = new FakeLease();
    const service = createService({ lease });
    const opened = await service.open(source('front_door'), 1);

    await opened.registerMessageReference({ chatId: 42, messageId: 9 });

    expect(lease.writes.at(-1)?.messageReferences).toEqual([
      { telegramId: 1, chatId: 42, messageId: 9 },
    ]);
  });

  it('keeps one grant and one retained message after one hundred opens by one user', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, lease, messages });

    for (let index = 1; index <= 100; index += 1) {
      const opened = await service.open(source('front_door'), 1);
      await opened.registerMessageReference({ chatId: 42, messageId: index });
    }

    expect(gateway.revoked).toHaveLength(99);
    expect(lease.current()?.messageReferences).toEqual([
      { telegramId: 1, chatId: 42, messageId: 100 },
    ]);
    expect(messages.deleted).toHaveLength(99);
    expect(messages.deleted.at(-1)).toEqual({ telegramId: 1, chatId: 42, messageId: 99 });

    await service.stop(1);
    expect(messages.deleted.filter((reference) => reference.messageId === 100)).toHaveLength(1);
  });

  it('deletes stored watch messages when explicitly stopped', async () => {
    const messages = new FakeMessageCleanup();
    const service = createService({ messages });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });

    await expect(service.stop(1)).resolves.toBe('front_door');

    expect(messages.deleted).toEqual([{ telegramId: 1, chatId: 42, messageId: 9 }]);
  });

  it('keeps explicit tunnel teardown successful when watch-message deletion fails', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    messages.deleteError = new Error('telegram unavailable');
    const service = createService({ gateway, lease, messages });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });

    await expect(service.stop(1)).resolves.toBe('front_door');

    expect(gateway.stopCalls).toBe(1);
    expect(lease.clearCalls).toBe(1);
  });

  it('deletes stored watch messages once when a timed-out stop eventually completes', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.deferStop = true;
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, messages, operationTimeoutMs: 100 });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });
    const stopping = service.stop(1);
    const stoppingRejected = expect(stopping).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);
    await stoppingRejected;
    expect(messages.deleted).toEqual([]);

    gateway.resolveStop();
    await vi.advanceTimersByTimeAsync(0);

    expect(messages.deleted).toEqual([{ telegramId: 1, chatId: 42, messageId: 9 }]);
    await expect(service.stop(1)).resolves.toBeNull();
    expect(messages.deleted).toHaveLength(1);
  });

  it('deletes stored watch messages once when blocked stop cleanup is retried', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.deferStop = true;
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, messages, operationTimeoutMs: 100 });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });
    const stopping = service.stop(1);
    const stoppingRejected = expect(stopping).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);
    await stoppingRejected;
    gateway.rejectStop(new Error('late stop failure'));
    await vi.advanceTimersByTimeAsync(0);
    gateway.deferStop = false;

    await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
      cameraName: 'garden',
    });

    expect(messages.deleted).toEqual([{ telegramId: 1, chatId: 42, messageId: 9 }]);
  });

  it('deletes stored watch messages when the session expires', async () => {
    vi.useFakeTimers();
    const clock = new FakeMonotonicClock(1_000);
    const messages = new FakeMessageCleanup();
    const service = createService({ clock, messages, durationMs: 100 });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });

    clock.advance(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(messages.deleted).toEqual([{ telegramId: 1, chatId: 42, messageId: 9 }]);
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

  it('leaves no stale reference when replacement registration fails', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, lease, messages });
    const first = await service.open(source('front_door'), 1);
    await first.registerMessageReference({ chatId: 42, messageId: 9 });
    const replacement = await service.open(source('front_door'), 1);
    lease.writeError = new Error('lease write failed');

    await expect(
      replacement.registerMessageReference({ chatId: 42, messageId: 10 }),
    ).rejects.toMatchObject({ code: 'LIVE_STREAM_UNAVAILABLE' });

    expect(lease.current()?.messageReferences).toEqual([]);
    expect(messages.deleted).toEqual([
      { telegramId: 1, chatId: 42, messageId: 9 },
    ]);
    await expect(service.revokeUser(1)).resolves.toBeUndefined();
    expect(gateway.revoked).toHaveLength(2);
  });

  it('times out a hung lease write, rejects callers, and retains the cleanup blocker', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.hangStop = true;
    const lease = new FakeLease();
    lease.hangWrite = true;
    const service = createService({ gateway, lease, operationTimeoutMs: 100 });
    const opening = service.open(source('front_door'), 1);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);

    await openingRejected;
    expect(gateway.stopCalls).toBe(1);
    await expect(service.open(source('garden'), 2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.startCalls).toHaveLength(1);
  });

  it('fences a timed-out old lease write and its cleanup before a replacement starts', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    lease.deferNextWrite = true;
    const service = createService({ gateway, lease, operationTimeoutMs: 100 });
    const opening = service.open(source('front_door'), 1);
    const openingRejected = expect(opening).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });

    await vi.advanceTimersByTimeAsync(100);
    await openingRejected;

    const replacement = service.open(source('garden'), 2);
    const replacementRejected = expect(replacement).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(100);
    await replacementRejected;
    expect(gateway.startCalls).toHaveLength(1);

    lease.resolveWrite();
    await vi.advanceTimersByTimeAsync(0);
    expect(lease.clearCalls).toBe(1);
    expect(lease.current()).toBeNull();

    await expect(service.open(source('garden'), 2)).resolves.toMatchObject({
      cameraName: 'garden',
    });
    expect(gateway.startCalls).toHaveLength(2);
    expect(lease.current()?.cameraId).toBe('garden');
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
      { sessionId: 'stale', pid: createLiveStreamProcessId(123), processIdentity: 'owned-process' },
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

  it('times out stalled boot recovery and emits only a sanitized alert', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.hangRecovery = true;
    const lease = new FakeLease({
      sessionNonce: 'stale',
      pid: createLiveStreamProcessId(123),
      processIdentity: 'owned-process',
      cameraId: 'front_door',
      diagnosticExpiresAtUnixMs: 0,
      messageReferences: [],
    });
    const alerts = new FakeAdminAlert();
    const service = createService({ gateway, lease, alerts, operationTimeoutMs: 100 });
    const initializing = service.onModuleInit();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    await expect(initializing).resolves.toBeUndefined();
    expect(alerts.alerts).toEqual([['live-stream-recovery-failed', undefined]]);
    expect(lease.clearCalls).toBe(1);
  });

  it('times out a hung recovery lease read and emits only a sanitized alert', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    lease.hangRead = true;
    const alerts = new FakeAdminAlert();
    const service = createService({ gateway, lease, alerts, operationTimeoutMs: 100 });
    const initializing = service.onModuleInit();

    await vi.advanceTimersByTimeAsync(100);

    await expect(initializing).resolves.toBeUndefined();
    expect(gateway.recoveryCalls).toEqual([]);
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

  it('tears down an active session once across explicit and module shutdown', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, lease, messages });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });

    await service.shutdown();
    await service.onModuleDestroy();

    expect(gateway.stopCalls).toBe(1);
    expect(lease.clearCalls).toBe(1);
    expect(messages.deleted).toEqual([
      { telegramId: 1, chatId: 42, messageId: 9 },
    ]);
  });

  it('contains teardown errors and rejects opens after shutdown begins', async () => {
    const gateway = new FakeGateway();
    const lease = new FakeLease();
    const messages = new FakeMessageCleanup();
    const service = createService({ gateway, lease, messages });
    const opened = await service.open(source('front_door'), 1);
    await opened.registerMessageReference({ chatId: 42, messageId: 9 });
    gateway.stopError = new Error('stop failed');
    messages.deleteError = new Error('delete failed');

    await expect(service.shutdown()).resolves.toBeUndefined();
    await expect(service.open(source('front_door'), 2)).rejects.toMatchObject({
      code: 'LIVE_STREAM_UNAVAILABLE',
    });
    expect(gateway.stopCalls).toBe(1);
    expect(lease.clearCalls).toBe(0);
    expect(lease.current()?.cameraId).toBe('front_door');
  });

  it('bounds a stalled shutdown and keeps the module fallback exactly once', async () => {
    vi.useFakeTimers();
    const gateway = new FakeGateway();
    gateway.hangStop = true;
    const lease = new FakeLease();
    const service = createService({ gateway, lease, operationTimeoutMs: 100 });
    await service.open(source('front_door'), 1);

    const shuttingDown = service.shutdown();
    await vi.advanceTimersByTimeAsync(100);

    await expect(shuttingDown).resolves.toBeUndefined();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(gateway.stopCalls).toBe(1);
    expect(lease.clearCalls).toBe(0);
    expect(lease.current()?.cameraId).toBe('front_door');
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
  messages?: FakeMessageCleanup;
  durationMs?: number;
  operationTimeoutMs?: number;
} = {}): LiveStreamSessionService {
  return new LiveStreamSessionService(
    input.gateway ?? new FakeGateway(),
    input.lease ?? new FakeLease(),
    input.clock ?? new FakeMonotonicClock(1_000),
    input.alerts ?? new FakeAdminAlert(),
    input.messages ?? new FakeMessageCleanup(),
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
  startCalls: { source: LiveStreamSource }[] = [];
  revoked: string[] = [];
  recoveryCalls: { pid: ReturnType<typeof createLiveStreamProcessId>; processIdentity: string }[] = [];
  stopCalls = 0;
  recoveryResult: 'stopped' | 'not-owned' = 'stopped';
  stopError?: Error;
  addViewerError?: Error;
  revokeError?: Error;
  hangAddViewer = false;
  hangRecovery = false;
  hangRevoke = false;
  hangStop = false;
  deferStop = false;
  throwStartSynchronously = false;
  private readonly stopResolvers: (() => void)[] = [];
  private readonly stopRejectors: ((error: Error) => void)[] = [];
  private failureHandler?: () => void;

  onFailure(handler: () => void): void {
    this.failureHandler = handler;
  }

  triggerFailure(): void {
    this.failureHandler?.();
  }

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
    if (this.hangRevoke) await new Promise<never>(() => undefined);
    this.revoked.push(tokenHash);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopError) throw this.stopError;
    if (this.hangStop) await new Promise<never>(() => undefined);
    if (this.deferStop) {
      await new Promise<void>((resolve, reject) => {
        this.stopResolvers.push(resolve);
        this.stopRejectors.push(reject);
      });
    }
  }

  resolveStop(): void {
    this.stopResolvers.shift()?.();
    this.stopRejectors.shift();
  }

  rejectStop(error: Error): void {
    this.stopResolvers.shift();
    this.stopRejectors.shift()?.(error);
  }

  async recoverOwnedProcess(input: {
    pid: ReturnType<typeof createLiveStreamProcessId>;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'> {
    this.recoveryCalls.push(input);
    if (this.hangRecovery) await new Promise<never>(() => undefined);
    return this.recoveryResult;
  }
}

class DeferredGateway extends FakeGateway {
  private readonly resolvers: (() => void)[] = [];

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
  hangRead = false;
  hangWrite = false;
  hangClear = false;
  deferNextWrite = false;
  deferNextClear = false;
  private readonly writeResolvers: (() => void)[] = [];
  private readonly clearResolvers: (() => void)[] = [];

  constructor(private lease: LiveStreamLease | null = null) {}

  async read(): Promise<LiveStreamLease | null> {
    if (this.hangRead) await new Promise<never>(() => undefined);
    return this.lease;
  }

  async write(lease: LiveStreamLease): Promise<void> {
    if (this.writeError) throw this.writeError;
    if (this.hangWrite) await new Promise<never>(() => undefined);
    if (this.deferNextWrite) {
      this.deferNextWrite = false;
      await new Promise<void>((resolve) => this.writeResolvers.push(resolve));
    }
    this.lease = lease;
    this.writes.push(lease);
  }

  async clear(): Promise<void> {
    if (this.clearError) throw this.clearError;
    if (this.hangClear) await new Promise<never>(() => undefined);
    if (this.deferNextClear) {
      this.deferNextClear = false;
      await new Promise<void>((resolve) => this.clearResolvers.push(resolve));
    }
    this.lease = null;
    this.clearCalls += 1;
  }

  resolveWrite(): void {
    this.writeResolvers.shift()?.();
  }

  resolveClear(): void {
    this.clearResolvers.shift()?.();
  }

  current(): LiveStreamLease | null {
    return this.lease;
  }
}

class FakeMessageCleanup {
  deleted: { chatId: number; messageId: number }[] = [];
  deleteError?: Error;

  async delete(reference: { chatId: number; messageId: number }): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(reference);
  }
}

class FakeAdminAlert implements AdminAlertPort {
  alerts: [string, string | undefined][] = [];

  async alert(kind: Parameters<AdminAlertPort['alert']>[0], detail?: string): Promise<void> {
    this.alerts.push([kind, detail]);
  }
}
