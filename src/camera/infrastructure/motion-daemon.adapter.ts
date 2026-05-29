import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MotionAlreadyRunningError } from '../domain/errors/motion-already-running.error';
import { MotionNotInstalledError } from '../domain/errors/motion-not-installed.error';
import { MotionStartFailedError } from '../domain/errors/motion-start-failed.error';
import { MotionStopFailedError } from '../domain/errors/motion-stop-failed.error';
import { MotionControlPort } from '../domain/ports/motion-control.port';

const exec = promisify(execFile);

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

/**
 * Production `MotionControlPort` — drives the Motion systemd unit (spec 20).
 *
 * `start`/`stop` go through `sudo systemctl`, whitelisted in
 * `/etc/sudoers.d/homeworker`. The worker never runs as root and never
 * calls the Motion binary directly.
 */
@Injectable()
export class MotionDaemonAdapter implements MotionControlPort {
  private readonly logger = new Logger(MotionDaemonAdapter.name);
  private readonly unit = process.env.MOTION_SYSTEMD_UNIT ?? 'motion';

  async isActive(): Promise<boolean> {
    try {
      const { stdout } = await exec('systemctl', ['is-active', this.unit], {
        timeout: 5000,
      });
      return stdout.trim() === 'active';
    } catch (err) {
      // `systemctl is-active` exits non-zero when the unit is inactive;
      // the word "active"/"inactive" is still written to stdout.
      const stdout = (err as ExecError).stdout ?? '';
      return stdout.trim() === 'active';
    }
  }

  async start(): Promise<void> {
    if (await this.isActive()) throw new MotionAlreadyRunningError();
    try {
      await exec('sudo', ['systemctl', 'start', this.unit], { timeout: 15000 });
    } catch (err) {
      const reason = this.reasonOf(err);
      this.logger.warn(`motion start failed: ${reason}`);
      if (this.looksUninstalled(reason)) throw new MotionNotInstalledError();
      throw new MotionStartFailedError(reason);
    }
  }

  async stop(): Promise<void> {
    try {
      await exec('sudo', ['systemctl', 'stop', this.unit], { timeout: 15000 });
    } catch (err) {
      const reason = this.reasonOf(err);
      this.logger.warn(`motion stop failed: ${reason}`);
      throw new MotionStopFailedError(reason);
    }
  }

  async restart(): Promise<void> {
    try {
      await exec('sudo', ['systemctl', 'restart', this.unit], { timeout: 15000 });
    } catch (err) {
      const reason = this.reasonOf(err);
      this.logger.warn(`motion restart failed: ${reason}`);
      if (this.looksUninstalled(reason)) throw new MotionNotInstalledError();
      throw new MotionStartFailedError(reason);
    }
  }

  private reasonOf(err: unknown): string {
    const e = err as ExecError;
    const text = (e.stderr ?? '').trim() || e.message;
    return text.replace(/\s+/g, ' ').slice(0, 200);
  }

  private looksUninstalled(reason: string): boolean {
    return /could not be found|not found|no such file|ENOENT/i.test(reason);
  }
}
