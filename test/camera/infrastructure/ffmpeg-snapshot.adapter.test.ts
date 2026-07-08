import { afterEach, describe, expect, it } from 'vitest';
import { FfmpegSnapshotAdapter } from '../../../src/camera/infrastructure/ffmpeg-snapshot.adapter';
import { SnapshotFailedError } from '../../../src/camera/domain/errors/snapshot-failed.error';

/** Overrides the protected ffmpeg call so no process is spawned. */
class TestAdapter extends FfmpegSnapshotAdapter {
  attempts: string[] = [];
  failFor = new Set<string>();

  protected override async capture(source: string, cameraName: string): Promise<Buffer> {
    this.attempts.push(source);
    if (this.failFor.has(source)) {
      throw new SnapshotFailedError(cameraName, `cannot open ${source}`);
    }
    return Buffer.from(`frame:${source}`);
  }
}

afterEach(() => {
  delete process.env.MOTION_SNAPSHOT_SOURCE;
  delete process.env.MOTION_SNAPSHOT_SOURCE_FRONT_DOOR;
});

describe('FfmpegSnapshotAdapter source fallback', () => {
  it('tries the Motion stream first, then falls back to the device', async () => {
    const adapter = new TestAdapter();
    adapter.failFor.add('http://127.0.0.1:8081');

    const buffer = await adapter.grab('front_door', 'Front door');

    expect(adapter.attempts).toEqual(['http://127.0.0.1:8081', '/dev/video0']);
    expect(buffer.toString()).toBe('frame:/dev/video0');
  });

  it('uses the stream without touching the device when it works', async () => {
    const adapter = new TestAdapter();

    await adapter.grab('front_door', 'Front door');

    expect(adapter.attempts).toEqual(['http://127.0.0.1:8081']);
  });

  it('uses MOTION_SNAPSHOT_SOURCE exclusively when set - no fallback', async () => {
    process.env.MOTION_SNAPSHOT_SOURCE = 'rtsp://cam.local/stream';
    const adapter = new TestAdapter();
    adapter.failFor.add('rtsp://cam.local/stream');

    await expect(adapter.grab('front_door', 'Front door')).rejects.toBeInstanceOf(
      SnapshotFailedError,
    );
    expect(adapter.attempts).toEqual(['rtsp://cam.local/stream']);
  });

  it('prefers the per-camera env override', async () => {
    process.env.MOTION_SNAPSHOT_SOURCE = 'rtsp://global/stream';
    process.env.MOTION_SNAPSHOT_SOURCE_FRONT_DOOR = '/dev/video7';
    const adapter = new TestAdapter();

    await adapter.grab('front_door', 'Front door');

    expect(adapter.attempts).toEqual(['/dev/video7']);
  });

  it('serves the TTL cache without a second capture', async () => {
    const adapter = new TestAdapter();

    await adapter.grab('front_door', 'Front door');
    await adapter.grab('front_door', 'Front door');

    expect(adapter.attempts).toHaveLength(1);
  });
});
