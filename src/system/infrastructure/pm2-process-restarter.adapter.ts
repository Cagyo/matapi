import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { ProcessRestarterPort } from '../domain/ports/process-restarter.port';

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

  async restart(): Promise<void> {
    const appName = process.env.PM2_APP_NAME ?? 'worker';
    this.logger.warn(`Triggering pm2 restart ${appName}`);
    const child = spawn('pm2', ['restart', appName], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }
}
