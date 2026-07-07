import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { MediaFilePort } from '../domain/ports/media-file.port';

const exec = promisify(execFile);

/**
 * Production `MediaFilePort` over the local Motion storage directory
 * (`MOTION_LOCAL_DIR`). Uses `du` for total usage and `fs` for per-file
 * checks. Every method degrades to a safe default on error.
 */
@Injectable()
export class FsMediaFileAdapter implements MediaFilePort {
  private readonly logger = new Logger(FsMediaFileAdapter.name);
  private readonly localDir = process.env.MOTION_LOCAL_DIR ?? '/home/pi/motion/videos';

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async sizeBytes(path: string): Promise<number | null> {
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  }

  async localUsageBytes(): Promise<number | null> {
    try {
      const { stdout } = await exec('du', ['-sk', this.localDir], {
        timeout: 10000,
      });
      const kb = Number(stdout.trim().split(/\s+/)[0]);
      return Number.isFinite(kb) ? kb * 1024 : null;
    } catch (err) {
      this.logger.warn(`du failed: ${(err as Error).message}`);
      return null;
    }
  }
}
