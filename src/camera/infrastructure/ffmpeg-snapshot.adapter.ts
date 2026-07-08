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
/** Motion's MJPEG stream - readable while the daemon holds the camera. */
const DEFAULT_STREAM_SOURCE = 'http://127.0.0.1:8081';
/** Raw device - only opens while Motion is NOT running (exclusive V4L2). */
const DEFAULT_DEVICE_SOURCE = '/dev/video0';

/**
 * Production `SnapshotPort` - grabs a single JPEG frame with ffmpeg
 * (spec 20). Tries Motion's MJPEG stream first, then the raw device, so
 * snapshots work whether or not the daemon is running. A short TTL cache
 * coalesces bursts so concurrent `/camera snapshot` calls reuse one ffmpeg
 * spawn rather than racing the device.
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

    const job = this.captureFirst(cameraId, cameraName)
      .then((buffer) => {
        this.cache.set(cameraId, { at: Date.now(), buffer });
        return buffer;
      })
      .finally(() => this.inflight.delete(cameraId));

    this.inflight.set(cameraId, job);
    return job;
  }

  /** Try each candidate source in order; first delivered frame wins. */
  private async captureFirst(cameraId: string, cameraName: string): Promise<Buffer> {
    const sources = this.sourcesFor(cameraId);
    let lastError: unknown = new SnapshotFailedError(cameraName, 'no snapshot source');
    for (const source of sources) {
      try {
        return await this.capture(source, cameraName);
      } catch (err) {
        lastError = err;
        this.logger.warn(`snapshot via ${source} failed: ${(err as Error).message}`);
      }
    }
    throw lastError;
  }

  /** Explicit env overrides pin a single source; otherwise stream -> device. */
  private sourcesFor(cameraId: string): string[] {
    const perCamera = process.env[`MOTION_SNAPSHOT_SOURCE_${cameraId.toUpperCase()}`];
    if (perCamera) return [perCamera];
    const global = process.env.MOTION_SNAPSHOT_SOURCE;
    if (global) return [global];
    return [DEFAULT_STREAM_SOURCE, DEFAULT_DEVICE_SOURCE];
  }

  /** Protected seam so tests can substitute the ffmpeg spawn. */
  protected capture(source: string, cameraName: string): Promise<Buffer> {
    // A hung HTTP stream would otherwise hold the spawn for the full 10s
    // process timeout before the device fallback runs - every snapshot would
    // block 10s while Motion is wedged. Cap network reads at 2s for http
    // sources only; device inputs keep just the process timeout.
    const inputArgs = source.startsWith('http')
      ? ['-rw_timeout', '2000000', '-i', source]
      : ['-i', source];
    return new Promise<Buffer>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', ...inputArgs, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
        { timeout: 10000, maxBuffer: MAX_SNAPSHOT_BYTES, encoding: 'buffer' },
        (err, stdout) => {
          if (err) {
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
}
