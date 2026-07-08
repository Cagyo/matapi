import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalFileInfo, LocalStoragePort } from '../domain/ports/local-storage.port';

const exec = promisify(execFile);

/**
 * Production `LocalStoragePort` over `MOTION_LOCAL_DIR` (spec 21). `usagePercent`
 * shells to `df -P`; deletions use `fs`. Every method degrades safely — a
 * failed `df` reports 0% so cleanup never deletes on bad data.
 */
@Injectable()
export class FsLocalStorageAdapter implements LocalStoragePort {
  private readonly logger = new Logger(FsLocalStorageAdapter.name);
  private readonly localDir = process.env.MOTION_LOCAL_DIR ?? '/home/pi/motion/videos';

  async usagePercent(): Promise<number> {
    try {
      const { stdout } = await exec('df', ['-P', this.localDir], { timeout: 10000 });
      const line = stdout.trim().split('\n').at(-1) ?? '';
      const match = /(\d+)%/.exec(line);
      return match ? Number(match[1]) : 0;
    } catch (err) {
      this.logger.warn(`df failed: ${(err as Error).message}`);
      return 0;
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    try {
      await rm(path, { force: true });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to delete ${path}: ${(err as Error).message}`);
      return false;
    }
  }

  async pruneEmptyDirs(): Promise<void> {
    try {
      await this.pruneDir(this.localDir, true);
    } catch (err) {
      this.logger.warn(`pruneEmptyDirs failed: ${(err as Error).message}`);
    }
  }

  async listFilesOlderThan(cutoff: Date): Promise<LocalFileInfo[]> {
    const out: LocalFileInfo[] = [];
    try {
      await this.collectOldFiles(this.localDir, cutoff.getTime(), out);
    } catch (err) {
      this.logger.warn(`listFilesOlderThan failed: ${(err as Error).message}`);
      return [];
    }
    return out;
  }

  /** Depth-first: remove now-empty subdirectories; never removes the root. */
  private async pruneDir(dir: string, isRoot: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.pruneDir(join(dir, entry.name), false);
      }
    }
    if (isRoot) return;
    try {
      const remaining = await readdir(dir);
      if (remaining.length === 0) await rmdir(dir);
    } catch {
      // non-empty or already gone — leave it
    }
  }

  private async collectOldFiles(dir: string, cutoffMs: number, out: LocalFileInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectOldFiles(full, cutoffMs, out);
      } else if (entry.isFile()) {
        try {
          const info = await stat(full);
          if (info.mtimeMs < cutoffMs) {
            out.push({ path: full, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
          }
        } catch {
          // stat raced a deletion — skip
        }
      }
    }
  }
}
