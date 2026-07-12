import { describe, expect, it } from 'vitest';
import {
  createLiveStreamProcessId,
  createLiveStreamSession,
  createViewerToken,
} from '../../../src/camera/domain/live-stream.entity';

describe('live stream domain', () => {
  it('creates a five-minute deadline from monotonic time', () => {
    const session = createLiveStreamSession({
      id: 's1',
      cameraId: 'front_door_cam',
      cameraName: 'Front door',
      startedMonotonicMs: 500,
      durationMs: 300_000,
    });

    expect(session.expiresMonotonicMs).toBe(300_500);
  });

  it('rejects a viewer secret shorter than 32 bytes', () => {
    expect(() => createViewerToken(Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects the nonsensical recovery process identifier %s',
    (pid) => {
      expect(() => createLiveStreamProcessId(pid)).toThrow(
        /positive safe integer/,
      );
    },
  );

  it('creates an opaque recovery process identifier from a positive safe integer', () => {
    expect(createLiveStreamProcessId(42)).toBe(42);
  });
});
