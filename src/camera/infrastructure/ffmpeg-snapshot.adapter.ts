import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { SnapshotFailedError } from '../domain/errors/snapshot-failed.error';
import { SnapshotPort } from '../domain/ports/snapshot.port';

interface CacheEntry {
  at: number;
  buffer: Buffer;
}

const DEFAULT_TTL_MS = 2000;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/**
 * Production `SnapshotPort` — grabs a single JPEG frame with ffmpeg
 * (spec 20). A short TTL cache coalesces bursts so concurrent `/camera
 * snapshot` calls reuse one ffmpeg spawn rather than racing the device.
 */
@Injectable()
export class FfmpegSnapshotAdapter implements SnapshotPort {
  private readonly logger = new Logger(FfmpegSnapshotAdapter.name);
  private readonly ttlMs = Number(process.env.MOTION_SNAPSHOT_CACHE_TTL_MS) || DEFAULT_TTL_MS;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();

  async grab(cameraId: string, cameraName: string): Promise<Buffer> {
    const cached = this.cache.get(cameraId);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.buffer;

    const existing = this.inflight.get(cameraId);
    if (existing) return existing;

    const job = this.capture(cameraId, cameraName)
      .then((buffer) => {
        this.cache.set(cameraId, { at: Date.now(), buffer });
        return buffer;
      })
      .finally(() => this.inflight.delete(cameraId));

    this.inflight.set(cameraId, job);
    return job;
  }

  private capture(cameraId: string, cameraName: string): Promise<Buffer> {
    const source = this.sourceFor(cameraId);
    return new Promise<Buffer>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-i', source, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
        { timeout: 10000, maxBuffer: MAX_SNAPSHOT_BYTES, encoding: 'buffer' },
        (err, stdout) => {
          if (err) {
            this.logger.warn(`ffmpeg snapshot failed: ${err.message}`);
            reject(new SnapshotFailedError(cameraName, err.message));
            return;
          }
          if (!stdout || stdout.length === 0) {
            reject(new SnapshotFailedError(cameraName, 'empty frame'));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private sourceFor(cameraId: string): string {
    const perCamera = process.env[`MOTION_SNAPSHOT_SOURCE_${cameraId.toUpperCase()}`];
    return perCamera ?? process.env.MOTION_SNAPSHOT_SOURCE ?? '/dev/video0';
  }
}
