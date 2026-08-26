import { describe, expect, it, vi } from 'vitest';
import { FeatureCameraRuntimeLifecycleService } from '../../../src/camera/application/feature-camera-runtime-lifecycle.service';
import type { LiveSourceSessionControlPort } from '../../../src/camera/domain/ports/live-source-session-control.port';

describe('FeatureCameraRuntimeLifecycleService', () => {
  it('stops watcher work before stopping Motion', async () => {
    const watcher = { stop: vi.fn().mockResolvedValue(undefined), start: vi.fn() };
    const motion = { stop: vi.fn().mockResolvedValue(undefined) };
    const gate = { close: vi.fn(), open: vi.fn() };
    const sessions = sessionControl();
    const lifecycle = new FeatureCameraRuntimeLifecycleService(watcher, motion as never, gate, sessions);

    await lifecycle.motion.beforeDisable();

    expect(watcher.stop.mock.invocationCallOrder[0]).toBeLessThan(motion.stop.mock.invocationCallOrder[0]);
  });

  it('closes RTSP starts before stopping active RTSP sessions', async () => {
    const watcher = { stop: vi.fn(), start: vi.fn() };
    const motion = { stop: vi.fn() };
    const gate = { close: vi.fn(), open: vi.fn(), isOpen: () => false };
    const sessions = sessionControl();
    const lifecycle = new FeatureCameraRuntimeLifecycleService(watcher, motion as never, gate, sessions);

    await lifecycle.rtsp.beforeDisable();

    expect(gate.isOpen()).toBe(false);
    expect(sessions.stopSourceKind).toHaveBeenCalledWith('rtsp');
    expect(sessions.stopCamera).not.toHaveBeenCalled();
  });
});

function sessionControl(): LiveSourceSessionControlPort {
  return {
    stopCamera: vi.fn().mockResolvedValue(undefined),
    stopSourceKind: vi.fn().mockResolvedValue(undefined),
  };
}
