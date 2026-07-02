import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { CameraBackendPort } from './camera-backend.interface';
import { CameraSensorConfig } from '../camera.config';

const execFileAsync = promisify(execFile);

export class UsbBackend implements CameraBackendPort {
  private readonly ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

  constructor(private readonly config: CameraSensorConfig) {}

  async captureSnapshot(): Promise<Buffer> {
    const device = this.config.device || '/dev/video0';
    const args = [
      '-y',
      '-f', 'v4l2',
      '-video_size', `${this.config.resolution.width}x${this.config.resolution.height}`,
      '-i', device,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-',
    ];

    const { stdout } = await execFileAsync(this.ffmpegPath, args, {
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });

    return stdout;
  }

  async probe(): Promise<boolean> {
    const device = this.config.device || '/dev/video0';
    try {
      await fs.promises.access(device, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
