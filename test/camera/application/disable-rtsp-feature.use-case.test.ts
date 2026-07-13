import { describe, expect, it, vi } from 'vitest';
import { DisableRtspFeatureUseCase } from '../../../src/camera/application/disable-rtsp-feature.use-case';
import { RtspSourceStartGate } from '../../../src/camera/application/rtsp-source-start-gate.service';

describe('DisableRtspFeatureUseCase', () => {
  it('closes the RTSP start gate before stopping RTSP work', async () => {
    const order: string[] = [];
    const gate = new RtspSourceStartGate();
    const close = vi.spyOn(gate, 'close').mockImplementation(() => {
      order.push('gate');
      return RtspSourceStartGate.prototype.close.call(gate);
    });
    const sessions = {
      stopSourceKind: vi.fn(async () => {
        order.push('stop');
      }),
    };

    await new DisableRtspFeatureUseCase(gate, sessions as never).beforeDisable('rtsp');

    expect(close).toHaveBeenCalledOnce();
    expect(sessions.stopSourceKind).toHaveBeenCalledWith('rtsp');
    expect(order).toEqual(['gate', 'stop']);
    expect(() => gate.assertCanStart('rtsp')).toThrow();
    expect(() => gate.assertCanStart('motion-mjpeg')).not.toThrow();
  });

  it('does nothing for non-RTSP feature names', async () => {
    const gate = new RtspSourceStartGate();
    const sessions = { stopSourceKind: vi.fn() };

    await new DisableRtspFeatureUseCase(gate, sessions as never).beforeDisable('motion');

    expect(sessions.stopSourceKind).not.toHaveBeenCalled();
    expect(() => gate.assertCanStart('rtsp')).not.toThrow();
  });

  it('keeps RTSP starts closed when stopping fails so cleanup can be retried', async () => {
    const gate = new RtspSourceStartGate();
    const sessions = { stopSourceKind: vi.fn().mockRejectedValue(new Error('stop failed')) };

    await expect(
      new DisableRtspFeatureUseCase(gate, sessions as never).beforeDisable('rtsp'),
    ).rejects.toThrow('stop failed');

    expect(() => gate.assertCanStart('rtsp')).toThrow();
  });
});
