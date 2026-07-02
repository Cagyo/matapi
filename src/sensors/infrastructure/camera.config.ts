import * as os from 'os';
import * as path from 'path';
import { CameraConfigInvalidError } from '../domain/errors/camera-config-invalid.error';

export interface CameraSensorConfig {
  type: 'rtsp' | 'mjpeg' | 'usb' | 'libcamera';
  url?: string;
  device?: string;
  snapshotCacheTtlMs: number;
  storagePath: string;
  username?: string;
  password?: string;
  resolution: { width: number; height: number };
}

export function parseCameraConfig(raw: Record<string, unknown> | null | undefined): CameraSensorConfig {
  if (!raw || typeof raw !== 'object') {
    throw new CameraConfigInvalidError('missing or invalid configuration object');
  }

  const validTypes = ['rtsp', 'mjpeg', 'usb', 'libcamera'];
  const type = raw.type as CameraSensorConfig['type'];
  if (!validTypes.includes(type)) {
    throw new CameraConfigInvalidError(`invalid camera "type": ${JSON.stringify(raw.type)}`);
  }

  if ((type === 'rtsp' || type === 'mjpeg') && (typeof raw.url !== 'string' || !raw.url.trim())) {
    throw new CameraConfigInvalidError(`camera type "${type}" requires a valid string "url"`);
  }

  let device = typeof raw.device === 'string' ? raw.device.trim() : undefined;
  if (type === 'usb' && !device) {
    device = '/dev/video0';
  }

  let snapshotCacheTtlMs = 2000;
  if (raw.snapshotCacheTtlMs !== undefined) {
    if (typeof raw.snapshotCacheTtlMs === 'number' && raw.snapshotCacheTtlMs >= 0) {
      snapshotCacheTtlMs = raw.snapshotCacheTtlMs;
    } else {
      throw new CameraConfigInvalidError(`invalid "snapshotCacheTtlMs": ${JSON.stringify(raw.snapshotCacheTtlMs)}`);
    }
  }

  const defaultStoragePath = process.env.CAMERA_STORAGE_PATH || path.join(os.homedir(), '.matapi/camera');
  const storagePath = typeof raw.storagePath === 'string' && raw.storagePath.trim()
    ? raw.storagePath.trim()
    : defaultStoragePath;

  let width = 1280;
  let height = 720;
  if (raw.resolution && typeof raw.resolution === 'object') {
    const res = raw.resolution as Record<string, unknown>;
    if (typeof res.width === 'number' && res.width > 0) width = res.width;
    if (typeof res.height === 'number' && res.height > 0) height = res.height;
  }

  return {
    type,
    url: typeof raw.url === 'string' ? raw.url.trim() : undefined,
    device,
    snapshotCacheTtlMs,
    storagePath,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    password: typeof raw.password === 'string' ? raw.password : undefined,
    resolution: { width, height },
  };
}
