import { describe, expect, it, vi } from 'vitest';
import { LiveViewReadinessBarrierService } from '../../../src/camera/application/live-view-readiness-barrier.service';
import { LiveViewStartGate } from '../../../src/camera/application/live-view-start-gate.service';
import { RtspSourceStartGate } from '../../../src/camera/application/rtsp-source-start-gate.service';
import { OpenLiveStreamUseCase } from '../../../src/camera/application/open-live-stream.use-case';
import { LiveStreamSourceResolverService } from '../../../src/camera/application/live-stream-source-resolver.service';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';

describe('live view boot readiness', () => {
  it.each(['execute', 'executeById'] as const)('waits before resolving sources or checking gates in %s', async (method) => {
    const gate = new LiveViewStartGate();
    const rtsp = new RtspSourceStartGate(undefined, true);
    const barrier = new LiveViewReadinessBarrierService(gate, rtsp);
    const resolve = vi.fn(async () => ({ kind: 'motion-mjpeg' }));
    const open = vi.fn(async () => ({ kind: 'started' }));
    const subject = new OpenLiveStreamUseCase(
      { resolve, resolveById: resolve } as unknown as LiveStreamSourceResolverService,
      { open } as unknown as LiveStreamSessionService,
      { isAvailable: async () => true }, gate, rtsp, undefined, barrier,
    );
    const opening = subject[method]({ telegramId: 1, cameraId: 'camera' });
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
    gate.openIfCurrent(gate.close());
    barrier.markReady();
    await opening;
    expect(open).toHaveBeenCalledOnce();
  });

  it('releases failed boot waiters with both gates closed', async () => {
    const gate = new LiveViewStartGate();
    gate.openIfCurrent(gate.close());
    const rtsp = new RtspSourceStartGate(undefined, true);
    const barrier = new LiveViewReadinessBarrierService(gate, rtsp);
    const waiting = barrier.wait();
    barrier.markFailedClosed();
    await waiting;
    expect(() => gate.assertCanStart()).toThrow();
    expect(rtsp.isOpen()).toBe(false);
  });
});
