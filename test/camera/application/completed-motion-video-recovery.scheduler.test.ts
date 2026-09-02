import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAlertService } from '../../../src/camera/application/admin-alert.service';
import {
  CompletedMotionVideoRecoveryScheduler,
} from '../../../src/camera/application/completed-motion-video-recovery.scheduler';
import {
  RegisterCompletedMotionVideosUseCase,
  type CompletedMotionRecoveryWorkResult,
} from '../../../src/camera/application/register-completed-motion-videos.use-case';
import { CompletedMotionVideoFilesystemError } from '../../../src/camera/domain/errors/completed-motion-video-filesystem.error';
import type {
  AdminAlertPort,
  CameraAdminAlert,
} from '../../../src/camera/domain/ports/admin-alert.port';
import {
  COMPLETED_MOTION_VIDEO,
  type CompletedMotionVideoPort,
  type CompletedMotionVideoTraversal,
} from '../../../src/camera/domain/ports/completed-motion-video.port';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1_000;
const SCAN_ALERT_REPEAT_MS = 6 * 60 * 60 * 1_000;
const OPTIONS = {
  entryLimit: 64,
  hashByteLimit: 8_388_608,
  wallTimeMs: 100,
  descriptorLimit: 16,
};
const COMPLETE: CompletedMotionRecoveryWorkResult = {
  complete: true,
  madeProgress: true,
  budgetExhausted: false,
};
const MORE: CompletedMotionRecoveryWorkResult = {
  complete: false,
  madeProgress: true,
  budgetExhausted: true,
};

describe('CompletedMotionVideoRecoveryScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('binds the registration and traversal constructor dependencies to explicit tokens', () => {
    const dependencies = Reflect.getMetadata('self:paramtypes', CompletedMotionVideoRecoveryScheduler) as {
      index: number;
      param: unknown;
    }[];

    expect(dependencies).toContainEqual({
      index: 1,
      param: RegisterCompletedMotionVideosUseCase,
    });
    expect(dependencies).toContainEqual({ index: 2, param: COMPLETED_MOTION_VIDEO });
  });

  it('opens one root traversal at application bootstrap and closes it after completion', async () => {
    const fixture = schedulerFixture({ clock: mutableClock(100) });

    fixture.subject.onApplicationBootstrap();
    await fixture.subject.reconcile();

    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();
    expect(fixture.registration.reconcileBatch).toHaveBeenCalledWith(
      fixture.handles[0],
      OPTIONS,
      expect.any(AbortSignal),
    );
    expect(fixture.progress.motionTraversalCompleted).toHaveBeenCalledWith(100);
    expect(fixture.handles[0].close).toHaveBeenCalledOnce();
  });

  it('keeps one traversal open across cooperative batches and yields before continuing', async () => {
    const registration = vi.fn()
      .mockResolvedValueOnce(MORE)
      .mockResolvedValueOnce(MORE)
      .mockResolvedValueOnce(COMPLETE);
    const fixture = schedulerFixture({ registration });

    await fixture.subject.reconcile();

    expect(registration).toHaveBeenCalledTimes(3);
    expect(registration).toHaveBeenNthCalledWith(
      1,
      fixture.handles[0],
      OPTIONS,
      expect.any(AbortSignal),
    );
    expect(registration).toHaveBeenNthCalledWith(
      2,
      fixture.handles[0],
      OPTIONS,
      expect.any(AbortSignal),
    );
    expect(registration).toHaveBeenNthCalledWith(
      3,
      fixture.handles[0],
      OPTIONS,
      expect.any(AbortSignal),
    );
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();
    expect(fixture.handles[0].close).toHaveBeenCalledOnce();
  });

  it('shares a safety-started traversal with overlapping Archive callers', async () => {
    const active = deferred<CompletedMotionRecoveryWorkResult>();
    const fixture = schedulerFixture({ registration: vi.fn(() => active.promise) });

    fixture.subject.wake('safety');
    await until(() => fixture.registration.reconcileBatch.mock.calls.length === 1);
    const first = fixture.subject.reconcile();
    const second = fixture.subject.reconcile();

    expect(second).toBe(first);
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();

    active.resolve(COMPLETE);
    await first;
    expect(fixture.handles[0].close).toHaveBeenCalledOnce();
  });

  it('does not start a safety-only rescan when one traversal exceeds the safety interval', async () => {
    const active = deferred<CompletedMotionRecoveryWorkResult>();
    const clock = mutableClock();
    const fixture = schedulerFixture({
      clock,
      registration: vi.fn(async () => {
        const result = await active.promise;
        clock.advance(RECOVERY_INTERVAL_MS + 1);
        return result;
      }),
    });

    fixture.subject.wake('safety');
    await until(() => fixture.registration.reconcileBatch.mock.calls.length === 1);
    fixture.subject.wake('safety');
    active.resolve(COMPLETE);
    await fixture.subject.reconcile();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.registration.reconcileBatch).toHaveBeenCalledOnce();
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();
  });

  it('runs exactly one follow-up traversal for Motion wakes received mid-traversal', async () => {
    const first = deferred<CompletedMotionRecoveryWorkResult>();
    const registration = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(COMPLETE);
    const fixture = schedulerFixture({ registration });

    fixture.subject.wake('safety');
    const initialTraversal = fixture.subject.reconcile();
    await until(() => registration.mock.calls.length === 1);
    fixture.subject.wake('motion-event');
    fixture.subject.wake('motion-event');
    first.resolve(COMPLETE);

    await initialTraversal;
    await until(() => registration.mock.calls.length === 2);
    await until(() => fixture.handles[1].close.mock.calls.length === 1);
    expect(registration).toHaveBeenCalledTimes(2);
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledTimes(2);
    expect(fixture.handles[0].close).toHaveBeenCalledOnce();
    expect(fixture.handles[1].close).toHaveBeenCalledOnce();
  });

  it('preserves a Motion follow-up that arrives while the completed traversal is closing', async () => {
    const closing = deferred<void>();
    const first = traversal({ close: vi.fn(() => closing.promise) });
    const second = traversal();
    const fixture = schedulerFixture({ handles: [first, second] });

    fixture.subject.wake('safety');
    await until(() => first.close.mock.calls.length === 1);
    fixture.subject.wake('motion-event');
    closing.resolve(undefined);

    await until(() => fixture.completedVideos.openTraversal.mock.calls.length === 2);
    await until(() => second.close.mock.calls.length === 1);
    expect(fixture.registration.reconcileBatch).toHaveBeenCalledTimes(2);
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('lets Motion bypass the safety rest interval', async () => {
    const fixture = schedulerFixture();

    fixture.subject.wake('safety');
    await fixture.subject.reconcile();
    fixture.subject.wake('motion-event');
    await until(() => fixture.completedVideos.openTraversal.mock.calls.length === 2);
    await fixture.subject.reconcile();

    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledTimes(2);
  });

  it('coalesces an early safety wake until the rest interval expires', async () => {
    vi.useFakeTimers();
    const clock = mutableClock();
    const fixture = schedulerFixture({ clock });

    fixture.subject.wake('safety');
    await fixture.subject.reconcile();
    fixture.subject.wake('safety');
    await Promise.resolve();
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();

    clock.advance(RECOVERY_INTERVAL_MS - 1);
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS - 1);
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledOnce();

    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledTimes(2);
  });

  it('lets a Motion traversal satisfy an already-coalesced safety timer', async () => {
    vi.useFakeTimers();
    const clock = mutableClock();
    const fixture = schedulerFixture({ clock });

    fixture.subject.wake('safety');
    await fixture.subject.reconcile();
    fixture.subject.wake('safety');
    fixture.subject.wake('motion-event');
    await fixture.subject.reconcile();

    clock.advance(RECOVERY_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledTimes(2);
  });

  it('closes every opened traversal after success, failure, and cancellation', async () => {
    const success = schedulerFixture();
    await success.subject.reconcile();
    expect(success.handles[0].close).toHaveBeenCalledOnce();

    const failure = scanFailure();
    const failed = schedulerFixture({ registration: vi.fn().mockRejectedValue(failure) });
    await expect(failed.subject.reconcile()).rejects.toBe(failure);
    expect(failed.handles[0].close).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const cancelled = schedulerFixture({
      registration: vi.fn(async (_handle, _options, signal: AbortSignal) => {
        await aborted(signal);
        throw abortReason(signal);
      }),
    });
    const run = cancelled.subject.reconcile(controller.signal);
    await until(() => cancelled.registration.reconcileBatch.mock.calls.length === 1);
    controller.abort(new DOMException('shutdown', 'AbortError'));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled.handles[0].close).toHaveBeenCalledOnce();
  });

  it('opens a fresh root traversal after cancellation', async () => {
    const controller = new AbortController();
    const registration = vi.fn()
      .mockImplementationOnce(async (_handle, _options, signal: AbortSignal) => {
        await aborted(signal);
        throw abortReason(signal);
      })
      .mockResolvedValueOnce(COMPLETE);
    const fixture = schedulerFixture({ registration });

    const first = fixture.subject.reconcile(controller.signal);
    await until(() => registration.mock.calls.length === 1);
    controller.abort(new DOMException('shutdown', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await fixture.subject.reconcile();

    expect(fixture.completedVideos.openTraversal).toHaveBeenCalledTimes(2);
    expect(registration.mock.calls[0][0]).toBe(fixture.handles[0]);
    expect(registration.mock.calls[1][0]).toBe(fixture.handles[1]);
  });

  it('clears only Motion wakes that predate the cancellation boundary', async () => {
    const observedAbort = deferred<void>();
    const release = deferred<void>();
    const registration = vi.fn()
      .mockImplementationOnce(async (_handle, _options, signal: AbortSignal) => {
        await aborted(signal);
        observedAbort.resolve(undefined);
        await release.promise;
        throw abortReason(signal);
      })
      .mockResolvedValueOnce(COMPLETE);
    const fixture = schedulerFixture({ registration });
    const controller = new AbortController();

    fixture.subject.wake('boot');
    await until(() => registration.mock.calls.length === 1);
    fixture.subject.wake('motion-event');
    const joined = fixture.subject.reconcile(controller.signal);
    controller.abort(new DOMException('shutdown', 'AbortError'));
    await observedAbort.promise;
    fixture.subject.wake('motion-event');
    release.resolve(undefined);

    await expect(joined).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => registration.mock.calls.length === 2);
    await until(() => fixture.handles[1].close.mock.calls.length === 1);
    expect(registration).toHaveBeenCalledTimes(2);
  });

  it('does not restart for a Motion wake that predates cancellation', async () => {
    const release = deferred<void>();
    const registration = vi.fn(async (_handle, _options, signal: AbortSignal) => {
      await aborted(signal);
      await release.promise;
      throw abortReason(signal);
    });
    const fixture = schedulerFixture({ registration });
    const controller = new AbortController();

    fixture.subject.wake('boot');
    await until(() => registration.mock.calls.length === 1);
    fixture.subject.wake('motion-event');
    const joined = fixture.subject.reconcile(controller.signal);
    controller.abort(new DOMException('shutdown', 'AbortError'));
    release.resolve(undefined);

    await expect(joined).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registration).toHaveBeenCalledOnce();
  });

  it('does no traversal work in stub mode', async () => {
    const fixture = schedulerFixture({ mode: 'stub' });

    fixture.subject.onApplicationBootstrap();
    fixture.subject.reconcileTick();
    fixture.subject.wake('motion-event');
    await fixture.subject.reconcile();

    expect(fixture.completedVideos.openTraversal).not.toHaveBeenCalled();
    expect(fixture.registration.reconcileBatch).not.toHaveBeenCalled();
  });

  it('logs only a sanitized code for a detached traversal failure', async () => {
    const fixture = schedulerFixture({ registration: vi.fn().mockRejectedValue(scanFailure()) });
    const log = vi.spyOn(loggerOf(fixture.subject), 'error').mockImplementation(() => undefined);

    fixture.subject.reconcileTick();
    await until(() => log.mock.calls.length === 1);

    expect(log).toHaveBeenCalledWith('Completed Motion recovery failed: motion_fs_access_denied');
    expect(JSON.stringify(log.mock.calls)).not.toContain('/motion');
  });
});

describe('CompletedMotionVideoRecoveryScheduler scan-failure alerting', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('raises one sanitized admin alert on the third consecutive failed traversal', async () => {
    const alerts = alertRecorder();
    const fixture = schedulerFixture({
      alerts,
      registration: vi.fn().mockRejectedValue(scanFailure()),
    });

    await failTraversals(fixture.subject, 3);

    expect(alerts.alert).toHaveBeenCalledOnce();
    expect(alerts.alert).toHaveBeenCalledWith('motion-scan-failing', 'motion_fs_access_denied');
  });

  it('re-arms failure alerting after a completed traversal', async () => {
    const alerts = alertRecorder();
    const registration = vi.fn()
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockResolvedValueOnce(COMPLETE)
      .mockRejectedValue(scanFailure());
    const fixture = schedulerFixture({ alerts, registration });

    await failTraversals(fixture.subject, 3);
    await fixture.subject.reconcile();
    await failTraversals(fixture.subject, 3);

    expect(alerts.alert).toHaveBeenCalledTimes(2);
  });

  it('never counts an aborted traversal toward the failure latch', async () => {
    const alerts = alertRecorder();
    const controller = new AbortController();
    const registration = vi.fn()
      .mockRejectedValueOnce(scanFailure())
      .mockRejectedValueOnce(scanFailure())
      .mockImplementationOnce(async (_handle, _options, signal: AbortSignal) => {
        controller.abort(new DOMException('shutdown', 'AbortError'));
        throw abortReason(signal);
      })
      .mockRejectedValue(scanFailure());
    const fixture = schedulerFixture({ alerts, registration });

    await failTraversals(fixture.subject, 2);
    await expect(fixture.subject.reconcile(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(alerts.alert).not.toHaveBeenCalled();
    await failTraversals(fixture.subject, 1);

    expect(alerts.alert).toHaveBeenCalledOnce();
  });

  it('does not blame the scan when only the completion progress write fails', async () => {
    const alerts = alertRecorder();
    const progressFailure = new Error('database is locked');
    const progress = {
      motionTraversalCompleted: vi.fn(async () => {
        throw progressFailure;
      }),
    };
    const fixture = schedulerFixture({ alerts, progress });

    for (let index = 0; index < 6; index += 1) {
      await expect(fixture.subject.reconcile()).rejects.toBe(progressFailure);
    }

    expect(alerts.alert).not.toHaveBeenCalled();
  });

  it('re-alerts after the repeat window while persistent failures continue', async () => {
    const alerts = alertRecorder();
    const clock = mutableClock();
    const fixture = schedulerFixture({
      alerts,
      clock,
      registration: vi.fn().mockRejectedValue(scanFailure()),
    });

    await failTraversals(fixture.subject, 3);
    clock.advance(SCAN_ALERT_REPEAT_MS - 1);
    await failTraversals(fixture.subject, 3);
    expect(alerts.alert).toHaveBeenCalledOnce();

    clock.advance(1);
    await failTraversals(fixture.subject, 1);
    expect(alerts.alert).toHaveBeenCalledTimes(2);
  });

  it('never leaks a raw failure path into an admin alert', async () => {
    const alerts = alertRecorder();
    const fixture = schedulerFixture({
      alerts,
      registration: vi.fn().mockRejectedValue(
        new Error("EACCES: permission denied, lstat '/home/pi/motion/videos'"),
      ),
    });

    await failTraversals(fixture.subject, 3);

    expect(alerts.alert).toHaveBeenCalledWith('motion-scan-failing', undefined);
    expect(JSON.stringify(alerts.alert.mock.calls)).not.toContain('/home/pi');
  });

  it('never lets a rejecting alert replace the traversal error', async () => {
    const failure = scanFailure();
    const alerts = alertRecorder(async () => {
      throw new Error('telegram unavailable');
    });
    const fixture = schedulerFixture({
      alerts,
      registration: vi.fn().mockRejectedValue(failure),
    });
    const warn = vi.spyOn(loggerOf(fixture.subject), 'warn').mockImplementation(() => undefined);

    await failTraversals(fixture.subject, 2);
    await expect(fixture.subject.reconcile()).rejects.toBe(failure);
    await until(() => warn.mock.calls.length === 1);

    expect(warn).toHaveBeenCalledWith(
      'Completed Motion recovery alert failed: CAMERA_OPERATION_FAILED',
    );
  });

  it('works with the delegate registered after early boot failures', async () => {
    const alerts = new AdminAlertService();
    vi.spyOn(loggerOfAlert(alerts), 'warn').mockImplementation(() => undefined);
    const delegate = alertRecorder();
    const clock = mutableClock();
    const fixture = schedulerFixture({
      alerts,
      clock,
      registration: vi.fn().mockRejectedValue(scanFailure()),
    });

    await failTraversals(fixture.subject, 3);
    alerts.register(delegate);
    clock.advance(SCAN_ALERT_REPEAT_MS);
    await failTraversals(fixture.subject, 1);
    await until(() => delegate.alert.mock.calls.length === 1);

    expect(delegate.alert).toHaveBeenCalledWith('motion-scan-failing', 'motion_fs_access_denied');
  });
});

type TraversalHandle = CompletedMotionVideoTraversal & { close: ReturnType<typeof vi.fn> };

function schedulerFixture(input: {
  mode?: 'real' | 'stub';
  registration?: ReturnType<typeof vi.fn>;
  handles?: TraversalHandle[];
  progress?: { motionTraversalCompleted: ReturnType<typeof vi.fn> };
  clock?: ReturnType<typeof mutableClock>;
  alerts?: AdminAlertPort;
} = {}) {
  const handles = input.handles ?? [];
  const openTraversal = vi.fn(async () => {
    const handle = handles[openTraversal.mock.calls.length - 1]
      ?? traversal();
    if (!handles.includes(handle)) handles.push(handle);
    return handle;
  });
  const completedVideos: CompletedMotionVideoPort & {
    openTraversal: typeof openTraversal;
  } = {
    resolve: vi.fn(async () => null),
    openTraversal,
  };
  const registration = {
    reconcileBatch: input.registration ?? vi.fn(async () => COMPLETE),
  };
  const progress = input.progress ?? {
    motionTraversalCompleted: vi.fn(async () => undefined),
  };
  const clock = input.clock ?? mutableClock(100);
  const subject = new CompletedMotionVideoRecoveryScheduler(
    input.mode ?? 'real',
    registration,
    completedVideos,
    OPTIONS,
    progress,
    clock,
    input.alerts,
  );
  vi.spyOn(loggerOf(subject), 'error').mockImplementation(() => undefined);
  vi.spyOn(loggerOf(subject), 'warn').mockImplementation(() => undefined);
  return {
    subject,
    registration,
    completedVideos,
    progress,
    clock,
    handles,
  };
}

function traversal(
  overrides: Partial<CompletedMotionVideoTraversal> = {},
): CompletedMotionVideoTraversal & { close: ReturnType<typeof vi.fn> } {
  return {
    pendingCandidate: vi.fn(() => null),
    inspect: vi.fn(async () => null),
    nextCandidate: vi.fn(async () => ({ candidate: null, visitedEntries: 0, complete: true })),
    continueHash: vi.fn(async () => ({ kind: 'rejected' as const, hashedBytes: 0 })),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as CompletedMotionVideoTraversal & { close: ReturnType<typeof vi.fn> };
}

function mutableClock(startMs = 0) {
  const clock = {
    nowMs: startMs,
    now: () => clock.nowMs,
    advance: (milliseconds: number) => {
      clock.nowMs += milliseconds;
    },
  };
  return clock;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

function scanFailure(): CompletedMotionVideoFilesystemError {
  return new CompletedMotionVideoFilesystemError('motion_fs_access_denied', 'inspect');
}

function alertRecorder(behaviour?: () => Promise<void>) {
  const alert = vi.fn(async (_kind: CameraAdminAlert, _detail?: string): Promise<void> => {
    await behaviour?.();
  });
  return { alert } satisfies AdminAlertPort;
}

function loggerOf(scheduler: CompletedMotionVideoRecoveryScheduler): {
  warn(message: string): void;
  error(message: string): void;
} {
  return (scheduler as unknown as {
    logger: { warn(message: string): void; error(message: string): void };
  }).logger;
}

function loggerOfAlert(alerts: AdminAlertService): { warn(message: string): void } {
  return (alerts as unknown as { logger: { warn(message: string): void } }).logger;
}

async function failTraversals(
  scheduler: CompletedMotionVideoRecoveryScheduler,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await expect(scheduler.reconcile()).rejects.toBeInstanceOf(Error);
  }
}
