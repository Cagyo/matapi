import { describe, expect, it } from 'vitest';
import {
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
});
