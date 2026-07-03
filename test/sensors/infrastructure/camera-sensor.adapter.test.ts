import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CameraSensorAdapter } from '../../../src/sensors/infrastructure/camera-sensor.adapter';
import { SensorConfig } from '../../../src/sensors/domain/sensor';
import { SensorEvent } from '../../../src/sensors/domain/sensor-event';

// Mock child_process execFile
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (args?.includes('-version')) {
      callback(null, { stdout: Buffer.from('ffmpeg version 6.0'), stderr: Buffer.from('') });
    } else if (args?.includes('image2pipe')) {
      callback(null, { stdout: Buffer.from('mock_jpeg_buffer'), stderr: Buffer.from('') });
    } else if (args?.includes('-f') && args.includes('null')) {
      callback(null, { stdout: Buffer.from('probe ok'), stderr: Buffer.from('') });
    } else {
      callback(null, { stdout: Buffer.from('ok'), stderr: Buffer.from('') });
    }
  }),
}));

describe('CameraSensorAdapter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'matapi-cam-test-'));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const rtspConfig: SensorConfig = {
    id: 'cam_rtsp',
    name: 'Front Door Cam',
    type: 'camera',
    config: {
      type: 'rtsp',
      url: 'rtsp://192.168.1.100:554/live',
      storagePath: undefined, // will be overridden in test or default
    },
    debounceMs: 0,
    severity: 'info',
  };

  it('initializes and reports health via backend probe', async () => {
    const cfg = {
      ...rtspConfig,
      config: { ...rtspConfig.config, storagePath: tmpDir },
    };
    const adapter = new CameraSensorAdapter();
    await adapter.init(cfg);

    const isHealthy = await adapter.healthCheck();
    expect(isHealthy).toBe(true);
    await adapter.destroy();
  });

  it('captures snapshot, saves to disk, and emits state_change event', async () => {
    const cfg = {
      ...rtspConfig,
      config: { ...rtspConfig.config, storagePath: tmpDir },
    };
    const adapter = new CameraSensorAdapter();
    const events: SensorEvent[] = [];
    adapter.onEvent((ev) => events.push(ev));

    await adapter.init(cfg);
    const snapshotPath = await adapter.captureSnapshot();

    expect(snapshotPath).not.toBeNull();
    expect(fs.existsSync(snapshotPath!)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sensorId: 'cam_rtsp',
      type: 'state_change',
      newValue: snapshotPath,
    });
    expect(adapter.getState().value).toBe(snapshotPath);
  });
});
