import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveWakeService } from '../../../src/archive/application/archive-wake.service';

describe('ArchiveWakeService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a wake that happens after the snapshot but before wait arming', async () => {
    vi.useFakeTimers();
    const wake = new ArchiveWakeService();
    const expectedEpoch = wake.snapshot();
    wake.wake();

    await expect(wake.waitForChange(
      expectedEpoch,
      null,
      60_000,
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an armed monotonic wait and removes its timer', async () => {
    vi.useFakeTimers();
    const wake = new ArchiveWakeService();
    const controller = new AbortController();
    const reason = new DOMException('stop archive wait', 'AbortError');
    const waiting = wake.waitForChange(
      wake.snapshot(),
      null,
      60_000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the freshly checked wall sample only to clamp a monotonic deadline wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const wake = new ArchiveWakeService();
    const controller = new AbortController();
    const waitWithCheckedWall = wake.waitForChange.bind(wake);
    const settled = vi.fn();

    void waitWithCheckedWall(
      wake.snapshot(),
      101_000,
      5_000,
      controller.signal,
      1_000,
    ).then(settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();

    vi.setSystemTime(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('does not extend an armed clamped wait after a backward wall-clock jump', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const wake = new ArchiveWakeService();
    const settled = vi.fn();
    void wake.waitForChange(
      wake.snapshot(),
      2_000_000,
      5_000,
      new AbortController().signal,
    ).then(settled);

    vi.setSystemTime(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
  });
});
