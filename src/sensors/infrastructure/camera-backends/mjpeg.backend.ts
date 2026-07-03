import { CameraBackendPort } from './camera-backend.interface';
import { CameraSensorConfig } from '../camera.config';

export class MjpegBackend implements CameraBackendPort {
  constructor(private readonly config: CameraSensorConfig) {}

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.username) {
      const auth = Buffer.from(`${this.config.username}:${this.config.password || ''}`).toString('base64');
      headers.Authorization = `Basic ${auth}`;
    }
    return headers;
  }

  async captureSnapshot(): Promise<Buffer> {
    if (!this.config.url) {
      throw new Error('MJPEG URL is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(this.config.url, {
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('image/jpeg')) {
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      }

      // Multipart stream: read chunks until we find SOI (FF D8) and EOI (FF D9)
      const reader = res.body.getReader();
      let buffer = Buffer.alloc(0);

      while (true) {
        const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (done) break;
        if (value) {
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          const soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          if (soi !== -1) {
            const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
            if (eoi !== -1) {
              const frame = buffer.subarray(soi, eoi + 2);
              void reader.cancel();
              return Buffer.from(frame);
            }
          }
        }
        if (buffer.length > 5 * 1024 * 1024) {
          throw new Error('Exceeded 5MB buffer without finding complete JPEG frame');
        }
      }

      throw new Error('Failed to extract JPEG frame from stream');
    } finally {
      clearTimeout(timeout);
    }
  }

  async probe(): Promise<boolean> {
    if (!this.config.url) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(this.config.url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      if (res.body) {
        const reader = res.body.getReader();
        void reader.cancel();
      }
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
