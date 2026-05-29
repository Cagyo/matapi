import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NoRollbackTagError } from '../domain/errors/no-rollback-tag.error';
import { OtaCheckFailedError } from '../domain/errors/ota-check-failed.error';
import { OtaPort, UpdateCheck } from '../domain/ports/ota.port';

const exec = promisify(execCb);

/**
 * Shell-script-backed OTA adapter. Delegates the install + restart sequence
 * to `scripts/update.sh` / `scripts/rollback.sh`. The script owns the
 * lockfile (`/tmp/home-worker-updating.lock`) via `trap`; this adapter
 * only reads it to honour the concurrency check.
 */
@Injectable()
export class ShellOtaAdapter implements OtaPort {
  private readonly logger = new Logger(ShellOtaAdapter.name);
  private readonly installDir =
    process.env.HOME_WORKER_INSTALL_DIR ?? process.cwd();
  private readonly lockfile =
    process.env.HOME_WORKER_UPDATE_LOCK ?? '/tmp/home-worker-updating.lock';

  async isLocked(): Promise<boolean> {
    try {
      await access(this.lockfile, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async checkForUpdates(): Promise<UpdateCheck> {
    try {
      await this.git('fetch', 'origin');
      const localCommit = (await this.git('rev-parse', 'HEAD')).trim();
      const remoteCommit = (
        await this.git('rev-parse', 'origin/main')
      ).trim();
      return {
        hasUpdates: localCommit !== remoteCommit,
        localCommit,
        remoteCommit,
      };
    } catch (err) {
      throw new OtaCheckFailedError((err as Error).message);
    }
  }

  async startUpdate(): Promise<void> {
    this.spawnScript(resolve(this.installDir, 'scripts/update.sh'));
  }

  async startRollback(): Promise<void> {
    const tags = (
      await this.git('tag', '-l', 'rollback-*').catch(() => '')
    ).trim();
    if (!tags) throw new NoRollbackTagError();
    this.spawnScript(resolve(this.installDir, 'scripts/rollback.sh'));
  }

  private spawnScript(scriptPath: string): void {
    this.logger.warn(`Spawning OTA script ${scriptPath}`);
    const child = spawn('/bin/bash', [scriptPath], {
      cwd: this.installDir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec(
      `git ${args.map((arg) => this.shellEscape(arg)).join(' ')}`,
      { cwd: this.installDir },
    );
    return stdout;
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}
