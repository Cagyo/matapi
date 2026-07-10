import { describe, expect, it } from 'vitest';
import { CameraConfigInvalidError } from '../../../src/sensors/domain/errors/camera-config-invalid.error';
import { cameraConfigIssues } from '../../../src/sensors/domain/sensor-type-config-validation';
import { parseCameraConfig } from '../../../src/sensors/infrastructure/camera.config';

describe('parseCameraConfig', () => {
  it('normalizes a valid RTSP camera shape', () => {
    expect(
      parseCameraConfig({
        type: 'rtsp',
        url: ' rtsp://camera.local/live ',
        snapshotCacheTtlMs: 0,
        resolution: { width: 1920, height: 1080 },
      }),
    ).toMatchObject({
      type: 'rtsp',
      url: 'rtsp://camera.local/live',
      snapshotCacheTtlMs: 0,
      resolution: { width: 1920, height: 1080 },
    });
  });

  it('uses the first shared issue in its typed error', () => {
    const raw = { type: 'mjpeg', snapshotCacheTtlMs: 1.5 };
    const [issue] = cameraConfigIssues(raw);

    expect(() => parseCameraConfig(raw)).toThrowError(CameraConfigInvalidError);
    expect(() => parseCameraConfig(raw)).toThrow(issue);
  });
});
