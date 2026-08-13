import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletedMotionVideoRecoveryScheduler } from '../../../src/camera/application/completed-motion-video-recovery.scheduler';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('CompletedMotionVideoRecoveryScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts reconciliation at application bootstrap in real mode', async () => {
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });

    scheduler.onApplicationBootstrap();

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(reconcile).toHaveBeenCalledWith(undefined);
  });

  it('shares an interval-started pass with overlapping Archive callers', async () => {
    const active = deferred();
    const reconcile = vi.fn(() => active.promise);
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });

    scheduler.reconcileTick();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    const archiveSignal = new AbortController().signal;
    const archiveCall = scheduler.reconcile(archiveSignal);
    const overlappingCall = scheduler.reconcile();

    expect(overlappingCall).toBe(archiveCall);
    expect(reconcile).toHaveBeenCalledTimes(1);

    active.resolve();
    await archiveCall;
  });

  it('starts a new pass after the shared promise fulfills', async () => {
    const firstRun = deferred();
    const reconcile = vi.fn()
      .mockReturnValueOnce(firstRun.promise)
      .mockResolvedValueOnce(undefined);
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });

    const first = scheduler.reconcile();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    firstRun.resolve();
    await first;

    const second = scheduler.reconcile();

    expect(second).not.toBe(first);
    await expect(second).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('forwards an Archive cancellation signal to registration', async () => {
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });
    const signal = new AbortController().signal;

    await scheduler.reconcile(signal);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(signal);
  });

  it('propagates an awaited failure and permits the next pass', async () => {
    const failure = new Error('private failure detail');
    const reconcile = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });

    await expect(scheduler.reconcile()).rejects.toBe(failure);
    await expect(scheduler.reconcile()).resolves.toBeUndefined();

    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('logs a sanitized failure for a detached interval pass', async () => {
    const reconcile = vi.fn().mockRejectedValue(new Error('/private/motion/video.avi'));
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });
    const logger = (scheduler as unknown as {
      logger: { error(message: string): void };
    }).logger;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    scheduler.reconcileTick();

    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(log).toHaveBeenCalledWith('Completed Motion recovery failed');
  });

  it('performs no reconciliation in stub mode', async () => {
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new CompletedMotionVideoRecoveryScheduler('stub', { reconcile });

    scheduler.onApplicationBootstrap();
    scheduler.reconcileTick();
    await scheduler.reconcile(new AbortController().signal);

    expect(reconcile).not.toHaveBeenCalled();
  });
});
