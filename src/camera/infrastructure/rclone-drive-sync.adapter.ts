import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { GdriveNotConfiguredError } from '../domain/errors/gdrive-not-configured.error';
import { GdriveNotInstalledError } from '../domain/errors/gdrive-not-installed.error';
import { GdriveUploadFailedError } from '../domain/errors/gdrive-upload-failed.error';
import { DriveSyncPort } from '../domain/ports/drive-sync.port';

const exec = promisify(execFile);

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

const RCLONE_TIMEOUT_MS = 30 * 60 * 1000; // long enough for a Pi-rate bulk copy

/**
 * Production `DriveSyncPort` — `rclone copy`/`delete` under `ionice -c3`
 * (spec 21). Uses `copy` (additive, one-way) never `sync`, so local cleanup
 * never propagates deletions to Drive. Bandwidth and parallelism are capped
 * for the Pi via `RCLONE_BW_LIMIT` / `RCLONE_TRANSFERS`.
 */
@Injectable()
export class RcloneDriveSyncAdapter implements DriveSyncPort {
  private readonly logger = new Logger(RcloneDriveSyncAdapter.name);
  private readonly remote = process.env.GDRIVE_REMOTE_NAME ?? 'gdrive';
  private readonly motionPath = process.env.GDRIVE_REMOTE_PATH ?? 'home-security/motion';
  private readonly localDir = process.env.MOTION_LOCAL_DIR ?? '/var/lib/motion';

  /** Backups live alongside the motion path, e.g. `home-security/backups`. */
  private get backupsPath(): string {
    return posix.join(posix.dirname(this.motionPath), 'backups');
  }

  private get transfers(): string {
    const raw = Number(process.env.RCLONE_TRANSFERS);
    return Number.isFinite(raw) && raw > 0 ? String(Math.trunc(raw)) : '2';
  }

  private get bwLimit(): string {
    return process.env.RCLONE_BW_LIMIT ?? '1M';
  }

  async copyMotionFiles(): Promise<void> {
    await this.rclone([
      'copy',
      `${this.localDir}/`,
      `${this.remote}:${this.motionPath}/`,
      '--min-age',
      '1m',
      '--transfers',
      this.transfers,
      '--bwlimit',
      this.bwLimit,
    ]);
  }

  async pruneMotionFiles(minAgeDays: number): Promise<void> {
    await this.rclone([
      'delete',
      `${this.remote}:${this.motionPath}`,
      '--min-age',
      `${this.ageDays(minAgeDays)}d`,
      '--rmdirs',
    ]);
  }

  async uploadBackup(localPath: string, remoteName: string): Promise<void> {
    await this.rclone([
      'copyto',
      localPath,
      `${this.remote}:${posix.join(this.backupsPath, remoteName)}`,
      '--bwlimit',
      this.bwLimit,
    ]);
  }

  async pruneBackups(minAgeDays: number): Promise<void> {
    await this.rclone([
      'delete',
      `${this.remote}:${this.backupsPath}`,
      '--min-age',
      `${this.ageDays(minAgeDays)}d`,
    ]);
  }

  private ageDays(days: number): number {
    return Number.isFinite(days) && days > 0 ? Math.trunc(days) : 30;
  }

  /**
   * Run `ionice -c3 rclone <args>`. `ionice` keeps Drive I/O at idle priority
   * so it never starves SQLite writes; if `ionice` is absent we fall back to a
   * bare `rclone` invocation.
   */
  private async rclone(args: string[]): Promise<void> {
    try {
      await exec('ionice', ['-c3', 'rclone', ...args], { timeout: RCLONE_TIMEOUT_MS });
    } catch (err) {
      const e = err as ExecError;
      if (e.code === 'ENOENT' && (e.message ?? '').includes('ionice')) {
        await this.rcloneDirect(args);
        return;
      }
      throw this.mapError(err);
    }
  }

  private async rcloneDirect(args: string[]): Promise<void> {
    try {
      await exec('rclone', args, { timeout: RCLONE_TIMEOUT_MS });
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private mapError(err: unknown): Error {
    const e = err as ExecError;
    const text = `${e.stderr ?? ''} ${e.message ?? ''}`.trim();
    this.logger.warn(`rclone failed: ${text}`);
    if (e.code === 'ENOENT' || /not found|command not found/i.test(text)) {
      return new GdriveNotInstalledError();
    }
    if (/didn't find section|not found in config|no remote|unknown remote/i.test(text)) {
      return new GdriveNotConfiguredError();
    }
    return new GdriveUploadFailedError(text.replace(/\s+/g, ' ').slice(0, 200));
  }
}
