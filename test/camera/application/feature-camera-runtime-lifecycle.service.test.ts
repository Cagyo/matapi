import { describe, expect, it, vi } from 'vitest';
import { FeatureCameraRuntimeLifecycleService } from '../../../src/camera/application/feature-camera-runtime-lifecycle.service';

describe('FeatureCameraRuntimeLifecycleService', () => {
  it('stops watcher work before stopping Motion', async () => {
    const watcher = { stop: vi.fn().mockResolvedValue(undefined), start: vi.fn() };
    const motion = { stop: vi.fn().mockResolvedValue(undefined) };
    const gate = { close: vi.fn(), open: vi.fn() };
    const sessions = { stopSourceKind: vi.fn().mockResolvedValue(undefined) };
    const lifecycle = new FeatureCameraRuntimeLifecycleService(watcher, motion as never, gate, sessions as never);

    await lifecycle.motion.beforeDisable();

    expect(watcher.stop.mock.invocationCallOrder[0]).toBeLessThan(motion.stop.mock.invocationCallOrder[0]);
  });

  it('closes RTSP starts before stopping active RTSP sessions', async () => {
    const watcher = { stop: vi.fn(), start: vi.fn() };
    const motion = { stop: vi.fn() };
    const gate = { close: vi.fn(), open: vi.fn(), isOpen: () => false };
    const sessions = { stopSourceKind: vi.fn().mockResolvedValue(undefined) };
    const lifecycle = new FeatureCameraRuntimeLifecycleService(watcher, motion as never, gate, sessions as never);

    await lifecycle.rtsp.beforeDisable();

    expect(gate.isOpen()).toBe(false);
    expect(sessions.stopSourceKind).toHaveBeenCalledWith('rtsp');
  });
});
