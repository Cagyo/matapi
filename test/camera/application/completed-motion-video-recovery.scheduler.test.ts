import { describe, expect, it, vi } from 'vitest';
import { CompletedMotionVideoRecoveryScheduler } from '../../../src/camera/application/completed-motion-video-recovery.scheduler';

describe('CompletedMotionVideoRecoveryScheduler', () => {
  it('runs at boot and skips an overlapping periodic recovery', async () => {
    let release!: () => void;
    const reconcile = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const scheduler = new CompletedMotionVideoRecoveryScheduler('real', { reconcile });

    scheduler.onApplicationBootstrap();
    scheduler.reconcileTick();
    scheduler.reconcileTick();

    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    scheduler.reconcileTick();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not touch the filesystem in stub mode', async () => {
    const reconcile = vi.fn();
    const scheduler = new CompletedMotionVideoRecoveryScheduler('stub', { reconcile });

    scheduler.onApplicationBootstrap();
    scheduler.reconcileTick();

    expect(reconcile).not.toHaveBeenCalled();
  });
});
