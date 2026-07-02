import { execFile } from 'child_process';
import { promisify } from 'util';
import { CameraBackendPort } from './camera-backend.interface';
import { CameraSensorConfig } from '../camera.config';

const execFileAsync = promisify(execFile);

export class LibcameraBackend implements CameraBackendPort {
  constructor(private readonly config: CameraSensorConfig) {}

  async captureSnapshot(): Promise<Buffer> {
    const args = [
      '--width', `${this.config.resolution.width}`,
      '--height', `${this.config.resolution.height}`,
      '--timeout', '1',
      '--encoding', 'jpg',
      '--output', '-',
    ];

    const { stdout } = await execFileAsync('libcamera-still', args, {
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });

    return stdout;
  }

  async probe(): Promise<boolean> {
    try {
      await execFileAsync('libcamera-still', ['--list-cameras'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}
