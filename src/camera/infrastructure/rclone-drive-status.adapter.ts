import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GdriveNotConfiguredError } from '../domain/errors/gdrive-not-configured.error';
import { GdriveNotInstalledError } from '../domain/errors/gdrive-not-installed.error';
import { GdriveStatusFailedError } from '../domain/errors/gdrive-status-failed.error';
import { DriveQuota, DriveStatusPort } from '../domain/ports/drive-status.port';

const exec = promisify(execFile);

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

interface RcloneAbout {
  total?: number;
  used?: number;
  free?: number;
}

/**
 * Production `DriveStatusPort` — `rclone about <remote>: --json` (spec 15).
 * Distinguishes "rclone missing", "remote not configured", and generic
 * failures so the bot can render the right message.
 */
@Injectable()
export class RcloneDriveStatusAdapter implements DriveStatusPort {
  private readonly logger = new Logger(RcloneDriveStatusAdapter.name);
  private readonly remote = process.env.GDRIVE_REMOTE_NAME ?? 'gdrive';

  async about(): Promise<DriveQuota> {
    let stdout: string;
    try {
      ({ stdout } = await exec('rclone', ['about', `${this.remote}:`, '--json'], {
        timeout: 15000,
      }));
    } catch (err) {
      throw this.mapError(err);
    }

    let parsed: RcloneAbout;
    try {
      parsed = JSON.parse(stdout) as RcloneAbout;
    } catch (err) {
      throw new GdriveStatusFailedError(`invalid rclone output: ${(err as Error).message}`);
    }

    const total = Number(parsed.total ?? 0);
    const used = Number(parsed.used ?? 0);
    const free = Number(parsed.free ?? Math.max(0, total - used));
    return { totalBytes: total, usedBytes: used, freeBytes: free };
  }

  private mapError(err: unknown): Error {
    const e = err as ExecError;
    const text = `${e.stderr ?? ''} ${e.message ?? ''}`.trim();
    this.logger.warn(`rclone about failed: ${text}`);
    if (e.code === 'ENOENT' || /not found|command not found/i.test(text)) {
      return new GdriveNotInstalledError();
    }
    if (/didn't find section|not found in config|no remote|unknown remote/i.test(text)) {
      return new GdriveNotConfiguredError();
    }
    return new GdriveStatusFailedError(text.replace(/\s+/g, ' ').slice(0, 200));
  }
}
