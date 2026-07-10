import * as os from 'os';
import * as path from 'path';
import { CameraConfigInvalidError } from '../domain/errors/camera-config-invalid.error';
import { cameraConfigIssues } from '../domain/sensor-type-config-validation';

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

  const issues = cameraConfigIssues(raw);
  if (issues.length > 0) {
    throw new CameraConfigInvalidError(issues[0]);
  }

  const type = raw.type as CameraSensorConfig['type'];

  let device = typeof raw.device === 'string' ? raw.device.trim() : undefined;
  if (type === 'usb' && !device) {
    device = '/dev/video0';
  }

  let snapshotCacheTtlMs = 2000;
  if (raw.snapshotCacheTtlMs !== undefined) {
    snapshotCacheTtlMs = raw.snapshotCacheTtlMs as number;
  }

  const defaultStoragePath = process.env.CAMERA_STORAGE_PATH || path.join(os.homedir(), '.matapi/camera');
  const storagePath = typeof raw.storagePath === 'string' && raw.storagePath.trim()
    ? raw.storagePath.trim()
    : defaultStoragePath;

  let width = 1280;
  let height = 720;
  if (raw.resolution && typeof raw.resolution === 'object') {
    const res = raw.resolution as Record<string, unknown>;
    if (res.width !== undefined) width = res.width as number;
    if (res.height !== undefined) height = res.height as number;
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
