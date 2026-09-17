import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import { ProcessRestarterPort } from "../domain/ports/process-restarter.port";

type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Triggers a fixed `pm2 restart <app>` command and acknowledges only its
 * successful exit. The current process is expected to be torn down by PM2.
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
    const appName = process.env.PM2_APP_NAME ?? "worker";
    this.logger.warn(`Triggering pm2 restart ${appName}`);
    const child = this.spawnProcess("pm2", ["restart", appName], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void) => {
        if (settled) return;
        settled = true;
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        operation();
      };
      const onError = (error: Error) => {
        settle(() => reject(error));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal !== null) {
          settle(() =>
            reject(new Error(`pm2 restart terminated by ${signal}`)),
          );
          return;
        }
        if (code !== 0) {
          settle(() =>
            reject(new Error(`pm2 restart exited with code ${String(code)}`)),
          );
          return;
        }
        settle(() => {
          child.unref();
          resolve();
        });
      };
      child.once("error", onError);
      child.once("close", onClose);
    });
  }
}
