import { execFile } from 'child_process';
import { promisify } from 'util';
import { CameraBackendPort } from './camera-backend.interface';
import { CameraSensorConfig } from '../camera.config';

const execFileAsync = promisify(execFile);

export class RtspBackend implements CameraBackendPort {
  private readonly ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

  constructor(private readonly config: CameraSensorConfig) {}

  private formatUrl(): string {
    let url = this.config.url || '';
    if (this.config.username && !url.includes('@')) {
      const auth = `${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password || '')}@`;
      url = url.replace(/^(rtsp:\/\/)/i, `$1${auth}`);
    }
    return url;
  }

  async captureSnapshot(): Promise<Buffer> {
    const url = this.formatUrl();
    const args = [
      '-y',
      '-rtsp_transport', 'tcp',
      '-timeout', '5000000', // 5s in microseconds for RTSP socket timeout
      '-i', url,
      '-frames:v', '1',
      '-s', `${this.config.resolution.width}x${this.config.resolution.height}`,
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
    try {
      const url = this.formatUrl();
      const args = [
        '-rtsp_transport', 'tcp',
        '-timeout', '5000000',
        '-i', url,
        '-t', '0.1',
        '-f', 'null',
        '-',
      ];
      await execFileAsync(this.ffmpegPath, args, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
