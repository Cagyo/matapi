import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletedMotionVideoRecoveryScheduler } from '../../../src/camera/application/completed-motion-video-recovery.scheduler';
import { RegisterCompletedMotionVideosUseCase } from '../../../src/camera/application/register-completed-motion-videos.use-case';

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

  it('binds the registration constructor dependency to its use-case token', () => {
    const dependencies = Reflect.getMetadata('self:paramtypes', CompletedMotionVideoRecoveryScheduler) as {
      index: number;
      param: unknown;
    }[];

    expect(dependencies).toContainEqual({
      index: 1,
      param: RegisterCompletedMotionVideosUseCase,
    });
  });

  it('starts reconciliation at application bootstrap in real mode', async () => {
    const reconcileBatch = vi.fn(async () => ({ cursor: null, complete: true }));
    const progress = { motionTraversalCompleted: vi.fn(async () => undefined) };
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcileBatch }, progress, { now: () => 100 });

    scheduler.onApplicationBootstrap();

    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    expect(reconcileBatch).toHaveBeenCalledWith(null, undefined);
    expect(progress.motionTraversalCompleted).toHaveBeenCalledWith(100);
  });

  it('shares an interval-started pass with overlapping Archive callers', async () => {
    const active = deferred();
    const reconcileBatch = vi.fn(async () => {
      await active.promise;
      return { cursor: null, complete: true };
    });
    const scheduler = schedulerWith(reconcileBatch);

    scheduler.reconcileTick();
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    const archiveSignal = new AbortController().signal;
    const archiveCall = scheduler.reconcile(archiveSignal);
    const overlappingCall = scheduler.reconcile();

    expect(overlappingCall).toBe(archiveCall);
    expect(reconcileBatch).toHaveBeenCalledTimes(1);

    active.resolve();
    await archiveCall;
  });

  it('starts a new pass after the shared promise fulfills', async () => {
    const firstRun = deferred();
    const reconcileBatch = vi.fn()
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        return { cursor: null, complete: true };
      })
      .mockResolvedValueOnce({ cursor: null, complete: true });
    const scheduler = schedulerWith(reconcileBatch);

    const first = scheduler.reconcile();
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    firstRun.resolve();
    await first;

    const second = scheduler.reconcile();

    expect(second).not.toBe(first);
    await expect(second).resolves.toBeUndefined();
    expect(reconcileBatch).toHaveBeenCalledTimes(2);
  });

  it('forwards an Archive cancellation signal to registration', async () => {
    const reconcileBatch = vi.fn(async () => ({ cursor: null, complete: true }));
    const scheduler = schedulerWith(reconcileBatch);
    const signal = new AbortController().signal;

    await scheduler.reconcile(signal);

    expect(reconcileBatch).toHaveBeenCalledOnce();
    expect(reconcileBatch).toHaveBeenCalledWith(null, signal);
  });

  it('propagates an awaited failure and permits the next pass', async () => {
    const failure = new Error('private failure detail');
    const reconcileBatch = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ cursor: null, complete: true });
    const scheduler = schedulerWith(reconcileBatch);

    await expect(scheduler.reconcile()).rejects.toBe(failure);
    await expect(scheduler.reconcile()).resolves.toBeUndefined();

    expect(reconcileBatch).toHaveBeenCalledTimes(2);
  });

  it('logs a sanitized failure for a detached interval pass', async () => {
    const reconcileBatch = vi.fn().mockRejectedValue(new Error('/private/motion/video.avi'));
    const scheduler = schedulerWith(reconcileBatch);
    const logger = (scheduler as unknown as {
      logger: { error(message: string): void };
    }).logger;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    scheduler.reconcileTick();

    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(log).toHaveBeenCalledWith('Completed Motion recovery failed');
  });

  it('performs no reconciliation in stub mode', async () => {
    const reconcileBatch = vi.fn(async () => ({ cursor: null, complete: true }));
    const scheduler = new CompletedMotionVideoRecoveryScheduler(
      'stub', { reconcileBatch }, { motionTraversalCompleted: vi.fn(async () => undefined) }, { now: () => 100 },
    );

    scheduler.onApplicationBootstrap();
    scheduler.reconcileTick();
    await scheduler.reconcile(new AbortController().signal);

    expect(reconcileBatch).not.toHaveBeenCalled();
  });

  it('continues immediately until more than 64 videos complete one traversal', async () => {
    const reconcileBatch = vi.fn()
      .mockResolvedValueOnce({ cursor: { frames: [{ relativeDirectory: '', nextEntry: 64 }] }, complete: false })
      .mockResolvedValueOnce({ cursor: { frames: [{ relativeDirectory: '', nextEntry: 128 }] }, complete: false })
      .mockResolvedValueOnce({ cursor: null, complete: true });
    const progress = { motionTraversalCompleted: vi.fn(async () => undefined) };
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcileBatch }, progress, { now: () => 100 });

    scheduler.wake('boot');

    await vi.waitFor(() => expect(progress.motionTraversalCompleted).toHaveBeenCalledWith(100));
    expect(reconcileBatch).toHaveBeenCalledTimes(3);
  });

  it('coalesces event and safety wakes while one traversal is active', async () => {
    const active = deferred();
    let concurrent = 0;
    let maximum = 0;
    const reconcileBatch = vi.fn(async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      if (reconcileBatch.mock.calls.length === 1) await active.promise;
      concurrent -= 1;
      return { cursor: null, complete: true };
    });
    const scheduler = schedulerWith(reconcileBatch);

    scheduler.wake('motion-event');
    scheduler.reconcileTick();
    scheduler.wake('motion-event');
    expect(maximum).toBe(1);
    active.resolve();

    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(1);
  });

  it('resets the cursor after cancellation so the next traversal restarts at root', async () => {
    const controller = new AbortController();
    const reconcileBatch = vi.fn()
      .mockResolvedValueOnce({ cursor: { frames: [{ relativeDirectory: '2026', nextEntry: 64 }] }, complete: false })
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException('shutdown', 'AbortError'));
        throw controller.signal.reason;
      })
      .mockResolvedValueOnce({ cursor: null, complete: true });
    const scheduler = schedulerWith(reconcileBatch);

    await expect(scheduler.reconcile(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await scheduler.reconcile();

    expect(reconcileBatch.mock.calls[0][0]).toBeNull();
    expect(reconcileBatch.mock.calls[1][0]).toEqual({ frames: [{ relativeDirectory: '2026', nextEntry: 64 }] });
    expect(reconcileBatch.mock.calls[2][0]).toBeNull();
  });
});

function schedulerWith(reconcileBatch: ReturnType<typeof vi.fn>) {
  return new CompletedMotionVideoRecoveryScheduler(
    'real', { reconcileBatch }, { motionTraversalCompleted: vi.fn(async () => undefined) }, { now: () => 100 },
  );
}
