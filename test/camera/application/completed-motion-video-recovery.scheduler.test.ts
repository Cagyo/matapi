import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletedMotionVideoRecoveryScheduler } from '../../../src/camera/application/completed-motion-video-recovery.scheduler';
import { RegisterCompletedMotionVideosUseCase } from '../../../src/camera/application/register-completed-motion-videos.use-case';
import { AdminAlertService } from '../../../src/camera/application/admin-alert.service';
import type {
  AdminAlertPort,
  CameraAdminAlert,
} from '../../../src/camera/domain/ports/admin-alert.port';
import { CompletedMotionVideoFilesystemError } from '../../../src/camera/domain/errors/completed-motion-video-filesystem.error';

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
    expect(reconcileBatch).toHaveBeenCalledWith(null, expect.any(AbortSignal));
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
    expect(reconcileBatch).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    expect(reconcileBatch.mock.calls[0][1]).not.toBe(signal);
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

  it('never advances durable traversal completion after a later filesystem batch fails', async () => {
    const cursor = { frames: [{ relativeDirectory: '2026', nextEntry: 64 }] };
    const failure = Object.assign(new Error('Motion filesystem operation failed'), {
      name: 'CompletedMotionVideoFilesystemError',
      code: 'motion_fs_io_failure',
      operation: 'read-directory',
    });
    const reconcileBatch = vi.fn()
      .mockResolvedValueOnce({ cursor, complete: false })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ cursor: null, complete: true });
    const progress = { motionTraversalCompleted: vi.fn(async () => undefined) };
    const scheduler = new CompletedMotionVideoRecoveryScheduler(
      'real', { reconcileBatch }, progress, { now: () => 100 },
    );

    await expect(scheduler.reconcile()).rejects.toBe(failure);
    expect(progress.motionTraversalCompleted).not.toHaveBeenCalled();

    await scheduler.reconcile();
    expect(reconcileBatch.mock.calls[0]?.[0]).toBeNull();
    expect(reconcileBatch.mock.calls[1]?.[0]).toEqual(cursor);
    expect(reconcileBatch.mock.calls[2]?.[0]).toBeNull();
    expect(progress.motionTraversalCompleted).toHaveBeenCalledOnce();
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
    expect(log).toHaveBeenCalledWith('Completed Motion recovery failed: CAMERA_OPERATION_FAILED');
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

  it('lets a later Archive caller cancel a traversal started by a detached wake', async () => {
    let traversalSignal: AbortSignal | undefined;
    const reconcileBatch = vi.fn()
      .mockImplementationOnce(async (_cursor, signal?: AbortSignal) => {
        traversalSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException('Aborted', 'AbortError'),
          );
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
        return { cursor: null, complete: true };
      })
      .mockResolvedValueOnce({ cursor: null, complete: true });
    const scheduler = schedulerWith(reconcileBatch);

    scheduler.wake('boot');
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    const lifecycle = new AbortController();
    const add = vi.spyOn(lifecycle.signal, 'addEventListener');
    const remove = vi.spyOn(lifecycle.signal, 'removeEventListener');
    const joined = scheduler.reconcile(lifecycle.signal);

    lifecycle.abort(new DOMException('shutdown', 'AbortError'));

    await expect(joined).rejects.toMatchObject({ name: 'AbortError' });
    expect(traversalSignal?.aborted).toBe(true);
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    await expect(scheduler.reconcile()).resolves.toBeUndefined();
    expect(reconcileBatch).toHaveBeenCalledTimes(2);
    expect(reconcileBatch.mock.calls[1][0]).toBeNull();
  });

  it('discards pre-abort wakes but preserves one wake received before cancellation settles', async () => {
    const abortObserved = deferred();
    const releaseRejection = deferred();
    let concurrent = 0;
    let maximum = 0;
    const reconcileBatch = vi.fn()
      .mockImplementationOnce(async (_cursor, signal?: AbortSignal) => {
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        await new Promise<void>((resolve) => {
          const aborted = () => {
            abortObserved.resolve();
            resolve();
          };
          if (signal?.aborted) aborted();
          else signal?.addEventListener('abort', aborted, { once: true });
        });
        await releaseRejection.promise;
        concurrent -= 1;
        throw signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError');
      })
      .mockImplementationOnce(async () => {
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        concurrent -= 1;
        return { cursor: null, complete: true };
      });
    const scheduler = schedulerWith(reconcileBatch);

    scheduler.wake('boot');
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    scheduler.wake('safety');
    const lifecycle = new AbortController();
    const joined = scheduler.reconcile(lifecycle.signal);
    lifecycle.abort(new DOMException('shutdown', 'AbortError'));
    await abortObserved.promise;
    scheduler.wake('motion-event');
    releaseRejection.resolve();

    await expect(joined).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcileBatch).toHaveBeenCalledTimes(2);
    expect(reconcileBatch.mock.calls[1][0]).toBeNull();
    expect(maximum).toBe(1);
  });

  it('does not restart for a wake that predates traversal cancellation', async () => {
    const abortObserved = deferred();
    const releaseRejection = deferred();
    const reconcileBatch = vi.fn(async (_cursor, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        const aborted = () => {
          abortObserved.resolve();
          resolve();
        };
        if (signal?.aborted) aborted();
        else signal?.addEventListener('abort', aborted, { once: true });
      });
      await releaseRejection.promise;
      throw signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
    });
    const scheduler = schedulerWith(reconcileBatch);

    scheduler.wake('boot');
    await vi.waitFor(() => expect(reconcileBatch).toHaveBeenCalledOnce());
    scheduler.wake('safety');
    const lifecycle = new AbortController();
    const joined = scheduler.reconcile(lifecycle.signal);
    lifecycle.abort(new DOMException('shutdown', 'AbortError'));
    await abortObserved.promise;
    releaseRejection.resolve();

    await expect(joined).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcileBatch).toHaveBeenCalledOnce();
  });
});

describe('CompletedMotionVideoRecoveryScheduler scan-failure alerting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays quiet while consecutive traversal failures remain below the threshold', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 2);

    expect(alerts.alert).not.toHaveBeenCalled();
  });

  it('raises exactly one admin alert on the third consecutive failed traversal', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 3);

    expect(alerts.alert).toHaveBeenCalledOnce();
    expect(alerts.alert).toHaveBeenCalledWith('motion-scan-failing', 'motion_fs_access_denied');
  });

  it('stays latched while the scan keeps failing', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 8);

    expect(alerts.alert).toHaveBeenCalledOnce();
  });

  it('re-arms the latch after a successful traversal', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn()
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockResolvedValueOnce({ cursor: null, complete: true })
      .mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 3);
    expect(alerts.alert).toHaveBeenCalledOnce();

    await expect(scheduler.reconcile()).resolves.toBeUndefined();
    await failTraversals(scheduler, 2);
    expect(alerts.alert).toHaveBeenCalledOnce();

    await failTraversals(scheduler, 1);
    expect(alerts.alert).toHaveBeenCalledTimes(2);
  });

  it('counts one shared traversal as a single failure however many callers await it', async () => {
    const alerts = alertRecorder();
    const active = { current: deferred() };
    const reconcileBatch = vi.fn(async () => {
      await active.current.promise;
      throw scanFailure();
    });
    const scheduler = schedulerWith(reconcileBatch, alerts);

    for (let traversal = 0; traversal < 3; traversal += 1) {
      active.current = deferred();
      const first = scheduler.reconcile();
      const second = scheduler.reconcile();
      const third = scheduler.reconcile();
      expect(second).toBe(first);
      expect(third).toBe(first);
      active.current.resolve();
      await Promise.allSettled([first, second, third]);
      if (traversal < 2) expect(alerts.alert).not.toHaveBeenCalled();
    }

    expect(reconcileBatch).toHaveBeenCalledTimes(3);
    expect(alerts.alert).toHaveBeenCalledOnce();
  });

  it('never counts an aborted traversal toward the alert latch', async () => {
    const alerts = alertRecorder();
    const controller = new AbortController();
    const reconcileBatch = vi.fn()
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException('shutdown', 'AbortError'));
        throw controller.signal.reason;
      })
      .mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 2);
    await expect(scheduler.reconcile(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(alerts.alert).not.toHaveBeenCalled();

    await failTraversals(scheduler, 1);

    expect(alerts.alert).toHaveBeenCalledOnce();
  });

  it('does not count a scan error raised while the traversal is being cancelled', async () => {
    const alerts = alertRecorder();
    const controller = new AbortController();
    const reconcileBatch = vi.fn()
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockImplementationOnce(async () => {
        // Shutdown lands mid-syscall; the adapter reports the raw failure.
        controller.abort(new DOMException('shutdown', 'AbortError'));
        throw scanFailure();
      })
      .mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 2);
    await expect(scheduler.reconcile(controller.signal))
      .rejects.toBeInstanceOf(CompletedMotionVideoFilesystemError);

    expect(alerts.alert).not.toHaveBeenCalled();

    await failTraversals(scheduler, 1);

    expect(alerts.alert).toHaveBeenCalledOnce();
  });

  it('keeps the traversal contract intact when the admin alert rejects', async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', capture);
    try {
      const alerts = alertRecorder(async () => {
        throw new Error('telegram DM to /home/pi admin failed');
      });
      const failure = scanFailure();
      const reconcileBatch = vi.fn().mockRejectedValue(failure);
      const scheduler = schedulerWith(reconcileBatch, alerts);
      const logger = (scheduler as unknown as { logger: { warn(message: string): void } }).logger;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      await expect(scheduler.reconcile()).rejects.toBe(failure);
      await expect(scheduler.reconcile()).rejects.toBe(failure);
      await expect(scheduler.reconcile()).rejects.toBe(failure);

      expect(alerts.alert).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toBe('Completed Motion recovery alert failed: CAMERA_OPERATION_FAILED');
      expect(warn.mock.calls[0]?.[0]).not.toContain('/home/pi');
    } finally {
      process.off('unhandledRejection', capture);
    }
  });

  it('does not blame the scan when only the traversal progress write keeps failing', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockResolvedValue({ cursor: null, complete: true });
    const progressFailure = new Error('database is locked');
    const progress = { motionTraversalCompleted: vi.fn(async () => { throw progressFailure; }) };
    const scheduler = new CompletedMotionVideoRecoveryScheduler(
      'real', { reconcileBatch }, progress, { now: () => 100 }, alerts,
    );

    for (let index = 0; index < 6; index += 1) {
      await expect(scheduler.reconcile()).rejects.toBe(progressFailure);
    }

    expect(alerts.alert).not.toHaveBeenCalled();
  });

  it('never lets a throwing alert delegate replace the scan error', async () => {
    const alerts = {
      alert: vi.fn(() => {
        throw new Error('no admin-alert delegate registered');
      }),
    } as unknown as AdminAlertPort & { alert: ReturnType<typeof vi.fn> };
    const failure = scanFailure();
    const reconcileBatch = vi.fn().mockRejectedValue(failure);
    const scheduler = schedulerWith(reconcileBatch, alerts);
    const logger = (scheduler as unknown as { logger: { warn(message: string): void } }).logger;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await failTraversals(scheduler, 2);
    await expect(scheduler.reconcile()).rejects.toBe(failure);

    expect(alerts.alert).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Completed Motion recovery alert failed: CAMERA_OPERATION_FAILED');
  });

  it('does not repeat the alert while the scan keeps failing inside the repeat window', async () => {
    const alerts = alertRecorder();
    const clock = mutableClock();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts, clock);

    await failTraversals(scheduler, 3);
    expect(alerts.alert).toHaveBeenCalledOnce();

    clock.nowMs += SCAN_ALERT_REPEAT_MS - 1;
    await failTraversals(scheduler, 10);

    expect(alerts.alert).toHaveBeenCalledOnce();
  });

  it('re-alerts after the repeat window so a first alert lost to boot ordering is not permanent silence', async () => {
    // Boot order is Archive (failure #1) → Camera (failure #2) → Telegram,
    // which registers the delegate. An alert raised before that is dropped by
    // AdminAlertService, which still resolves, so the scheduler cannot see it.
    const alerts = new AdminAlertService();
    const alertLogger = (alerts as unknown as { logger: { warn(message: string): void } }).logger;
    vi.spyOn(alertLogger, 'warn').mockImplementation(() => undefined);
    const delegate = { alert: vi.fn(async (): Promise<void> => undefined) };
    const clock = mutableClock();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts, clock);

    await failTraversals(scheduler, 3);
    alerts.register(delegate);
    await failTraversals(scheduler, 20);

    expect(delegate.alert).not.toHaveBeenCalled();

    clock.nowMs += SCAN_ALERT_REPEAT_MS;
    await failTraversals(scheduler, 1);

    await vi.waitFor(() => expect(delegate.alert).toHaveBeenCalledOnce());
    expect(delegate.alert).toHaveBeenCalledWith('motion-scan-failing', 'motion_fs_access_denied');
  });

  it('never alerts in stub mode', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = new CompletedMotionVideoRecoveryScheduler(
      'stub',
      { reconcileBatch },
      { motionTraversalCompleted: vi.fn(async () => undefined) },
      { now: () => 100 },
      alerts,
    );

    scheduler.onApplicationBootstrap();
    for (let index = 0; index < 5; index += 1) {
      scheduler.reconcileTick();
      await expect(scheduler.reconcile()).resolves.toBeUndefined();
    }

    expect(reconcileBatch).not.toHaveBeenCalled();
    expect(alerts.alert).not.toHaveBeenCalled();
  });

  it('never passes a raw filesystem path as the alert detail', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, lstat '/home/pi/motion/videos'"),
    );
    const scheduler = schedulerWith(reconcileBatch, alerts);

    await failTraversals(scheduler, 3);

    expect(alerts.alert).toHaveBeenCalledOnce();
    expect(alerts.alert).toHaveBeenCalledWith('motion-scan-failing', undefined);
    expect(JSON.stringify(alerts.alert.mock.calls)).not.toContain('/home/pi');
  });

  it('alerts from the detached safety tick as well as the Archive caller', async () => {
    const alerts = alertRecorder();
    const reconcileBatch = vi.fn().mockRejectedValue(scanFailure());
    const scheduler = schedulerWith(reconcileBatch, alerts);
    const logger = (scheduler as unknown as { logger: { error(message: string): void } }).logger;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    for (let tick = 0; tick < 3; tick += 1) {
      scheduler.reconcileTick();
      // The detached failure log runs after the traversal releases its slot,
      // so waiting on it is the observable "tick finished" signal.
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(tick + 1));
    }

    expect(alerts.alert).toHaveBeenCalledOnce();
    expect(alerts.alert).toHaveBeenCalledWith('motion-scan-failing', 'motion_fs_access_denied');
  });
});

const SCAN_ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

function mutableClock(startMs = 100) {
  const clock = { nowMs: startMs, now: () => clock.nowMs };
  return clock;
}

function schedulerWith(
  reconcileBatch: ReturnType<typeof vi.fn>,
  alerts?: AdminAlertPort,
  clock: { now(): number } = { now: () => 100 },
) {
  return new CompletedMotionVideoRecoveryScheduler(
    'real',
    { reconcileBatch },
    { motionTraversalCompleted: vi.fn(async () => undefined) },
    clock,
    alerts,
  );
}

function alertRecorder(behaviour?: () => Promise<void>) {
  const alert = vi.fn(async (_kind: CameraAdminAlert, _detail?: string): Promise<void> => {
    if (behaviour) await behaviour();
  });
  return { alert } satisfies AdminAlertPort;
}

function scanFailure() {
  return new CompletedMotionVideoFilesystemError('motion_fs_access_denied', 'inspect');
}

async function failTraversals(
  scheduler: CompletedMotionVideoRecoveryScheduler,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await expect(scheduler.reconcile()).rejects.toBeInstanceOf(Error);
  }
}
