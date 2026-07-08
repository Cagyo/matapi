import { Injectable, Logger, Optional } from '@nestjs/common';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { NoRollbackTagError } from '../domain/errors/no-rollback-tag.error';
import { OtaCheckFailedError } from '../domain/errors/ota-check-failed.error';
import { OtaPort, UpdateCheck } from '../domain/ports/ota.port';

export type OtaExecFn = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: OtaExecFn = promisify(execFileCb);

export const OTA_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME_WORKER_INSTALL_DIR',
  'HOME_WORKER_UPDATE_LOCK',
  'HOME_WORKER_GIT_BRANCH',
  'HOME_WORKER_REPO',
  'HOME_WORKER_RELEASE_URL',
  'PM2_APP_NAME',
  'DATABASE_PATH',
  'UPDATE_HEALTH_CHECK_SEC',
] as const;

export function filterEnv(
  source: NodeJS.ProcessEnv,
  allow: readonly string[] = OTA_ENV_ALLOWLIST,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

export function parseRemoteHead(stdout: string): string | null {
  const line = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!line.startsWith('origin/')) {
    return null;
  }
  const branch = line.slice('origin/'.length);
  return branch.length > 0 ? branch : null;
}

@Injectable()
export class ShellOtaAdapter implements OtaPort {
  private readonly logger = new Logger(ShellOtaAdapter.name);
  private readonly installDir =
    process.env.HOME_WORKER_INSTALL_DIR ?? process.cwd();
  private readonly lockfile =
    process.env.HOME_WORKER_UPDATE_LOCK ?? '/tmp/home-worker-updating.lock';

  constructor(@Optional() private readonly exec: OtaExecFn = defaultExec) {}

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
      const branch = await this.defaultBranch();
      const localCommit = (await this.git('rev-parse', 'HEAD')).trim();
      const remoteCommit = (
        await this.git('rev-parse', `origin/${branch}`)
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
    if (!tags) {
      throw new NoRollbackTagError();
    }
    this.spawnScript(resolve(this.installDir, 'scripts/rollback.sh'));
  }

  private async defaultBranch(): Promise<string> {
    const pinned = process.env.HOME_WORKER_GIT_BRANCH;
    if (pinned) {
      return pinned;
    }

    try {
      const head = await this.git(
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      );
      const parsed = parseRemoteHead(head);
      if (parsed) {
        return parsed;
      }
    } catch {
      // origin/HEAD not set locally; refresh it below.
    }

    try {
      await this.git('remote', 'set-head', 'origin', '--auto');
      const refreshed = await this.git(
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      );
      const parsed = parseRemoteHead(refreshed);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fall through to explicit branch probes.
    }

    for (const candidate of ['master', 'main']) {
      try {
        await this.git('rev-parse', '--verify', `origin/${candidate}`);
        return candidate;
      } catch {
        // Try the next common default branch name.
      }
    }

    throw new Error('Cannot determine origin default branch');
  }

  private spawnScript(scriptPath: string): void {
    this.logger.warn(`Spawning OTA script ${scriptPath}`);
    const child = spawn('/bin/bash', [scriptPath], {
      cwd: this.installDir,
      detached: true,
      stdio: 'ignore',
      env: filterEnv(process.env),
    });
    child.unref();
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await this.exec('git', args, { cwd: this.installDir });
    return stdout;
  }
}
