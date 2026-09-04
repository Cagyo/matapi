import { describe, expect, it, vi } from 'vitest';
import { FeatureCameraRuntimeLifecycleService } from '../../../src/camera/application/feature-camera-runtime-lifecycle.service';
import { LiveViewPolicyCoordinatorService } from '../../../src/camera/application/live-view-policy-coordinator.service';
import { LiveViewSettingsBusyError } from '../../../src/camera/domain/errors/live-view-settings-busy.error';
import type { LiveSourceSessionControlPort } from '../../../src/camera/domain/ports/live-source-session-control.port';

describe('FeatureCameraRuntimeLifecycleService', () => {
  it('stops watcher work before stopping Motion', async () => {
    const { lifecycle, watcher, motion } = createLifecycle();

    await lifecycle.motion.beforeDisable();

    expect(watcher.stop.mock.invocationCallOrder[0]).toBeLessThan(
      motion.stop.mock.invocationCallOrder[0],
    );
  });

  it('disables RTSP in gate, quiescence, and policy order', async () => {
    const order: string[] = [];
    const { lifecycle, settingsJobs, gate, sessions, reconcileRtspPolicy } = createLifecycle(order);

    await runRtspTransition(lifecycle, () => lifecycle.rtsp.beforeDisable());

    expect(order).toEqual([
      'settings-job-check',
      'rtsp-gate-close',
      'rtsp-quiesce',
      'policy:false',
    ]);
    expect(settingsJobs.findActive).toHaveBeenCalledOnce();
    expect(gate.isOpen()).toBe(false);
    expect(sessions.stopSourceKind).toHaveBeenCalledWith('rtsp');
    expect(sessions.stopCamera).not.toHaveBeenCalled();
    expect(reconcileRtspPolicy.execute).toHaveBeenCalledWith({ rtspEnabled: false });
  });

  it('enables RTSP policy before opening its source-start gate', async () => {
    const order: string[] = [];
    const { lifecycle, reconcileRtspPolicy, gate } = createLifecycle(order);

    await runRtspTransition(lifecycle, () => lifecycle.rtsp.afterEnable());

    expect(order).toEqual(['settings-job-check', 'policy:true', 'rtsp-gate-open']);
    expect(reconcileRtspPolicy.execute).toHaveBeenCalledWith({ rtspEnabled: true });
    expect(gate.isOpen()).toBe(true);
  });

  it.each(['beforeDisable', 'afterEnable'] as const)(
    'rejects %s while a settings job is active without touching RTSP runtime',
    async (transition) => {
      const order: string[] = [];
      const { lifecycle, settingsJobs, gate, sessions, reconcileRtspPolicy } = createLifecycle(order);
      vi.mocked(settingsJobs.findActive).mockImplementation(async () => {
        order.push('settings-job-check');
        return { id: 'settings-job' } as never;
      });

      await expect(
        runRtspTransition(lifecycle, () => lifecycle.rtsp[transition]()),
      ).rejects.toBeInstanceOf(LiveViewSettingsBusyError);

      expect(order).toEqual(['settings-job-check']);
      expect(gate.close).not.toHaveBeenCalled();
      expect(gate.open).not.toHaveBeenCalled();
      expect(sessions.stopSourceKind).not.toHaveBeenCalled();
      expect(reconcileRtspPolicy.execute).not.toHaveBeenCalled();
    },
  );

  it('holds one coordinator lease around the complete registered RTSP operation', async () => {
    const { lifecycle, coordinator } = createLifecycle();
    const interleavingSettingsMutation = vi.fn(async () => undefined);
    let interleavingError: unknown;

    await runRtspTransition(lifecycle, async () => {
      try {
        await coordinator.run('settings', interleavingSettingsMutation);
      } catch (error) {
        interleavingError = error;
      }
    });

    expect(interleavingError).toBeInstanceOf(LiveViewSettingsBusyError);
    expect(interleavingSettingsMutation).not.toHaveBeenCalled();
  });
});

function createLifecycle(order: string[] = []) {
  const watcher = {
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  };
  const motion = { stop: vi.fn().mockResolvedValue(undefined) };
  let gateOpen = false;
  const gate = {
    close: vi.fn(() => {
      order.push('rtsp-gate-close');
      gateOpen = false;
    }),
    open: vi.fn(async () => {
      order.push('rtsp-gate-open');
      gateOpen = true;
    }),
    isOpen: () => gateOpen,
  };
  const sessions = sessionControl(order);
  const settingsJobs = {
    findActive: vi.fn(async () => {
      order.push('settings-job-check');
      return null;
    }),
  };
  const coordinator = new LiveViewPolicyCoordinatorService();
  const reconcileRtspPolicy = {
    execute: vi.fn(async ({ rtspEnabled }: { rtspEnabled: boolean }) => {
      order.push(`policy:${String(rtspEnabled)}`);
    }),
  };
  const lifecycle = new FeatureCameraRuntimeLifecycleService(
    watcher as never,
    motion as never,
    gate as never,
    sessions,
    settingsJobs,
    coordinator,
    reconcileRtspPolicy as never,
  );
  return {
    lifecycle,
    watcher,
    motion,
    gate,
    sessions,
    settingsJobs,
    coordinator,
    reconcileRtspPolicy,
  };
}

function sessionControl(order: string[]): LiveSourceSessionControlPort {
  return {
    stopCamera: vi.fn().mockResolvedValue(undefined),
    stopSourceKind: vi.fn(async () => {
      order.push('rtsp-quiesce');
    }),
  };
}

function runRtspTransition<T>(
  lifecycle: FeatureCameraRuntimeLifecycleService,
  operation: () => Promise<T>,
): Promise<T> {
  if (!lifecycle.rtsp.runTransition) throw new Error('RTSP transition wrapper is missing');
  return lifecycle.rtsp.runTransition(operation);
}
