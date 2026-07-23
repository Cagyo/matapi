import { Injectable, Logger, Optional } from '@nestjs/common';
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { ProcessRestarterPort } from '../domain/ports/process-restarter.port';

type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Triggers a `pm2 restart worker` and detaches. The current process is
 * expected to be torn down by PM2 shortly after this resolves.
 *
 * The PM2 app name is overridable with `PM2_APP_NAME` (defaults to
 * `worker` per `ecosystem.config.js`).
 */
@Injectable()
export class Pm2ProcessRestarter implements ProcessRestarterPort {
  private readonly logger = new Logger(Pm2ProcessRestarter.name);

  constructor(
    @Optional() private readonly spawnProcess: ProcessSpawner = spawn,
  ) {}

  async restart(): Promise<void> {
    const appName = process.env.PM2_APP_NAME ?? 'worker';
    this.logger.warn(`Triggering pm2 restart ${appName}`);
    const child = this.spawnProcess('pm2', ['restart', appName], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        child.removeListener('spawn', onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }
}
