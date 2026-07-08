import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Single-instance guard. Only `release()`s a lock this instance acquired, so a
 * second worker that fails to start can never delete the running worker's lock.
 */
export class PidLockGateway {
  private acquired = false;

  constructor(private readonly path: string) {}

  acquire(): void {
    // check-then-write below is not atomic, but PM2 runs a single instance
    // (`instances=1`), so two simultaneous starts can't race here. The bug #1
    // targets is release() deleting a lock this instance never held — the
    // `acquired` flag, not atomicity of acquire(), is what closes that.
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const oldPid = Number(readFileSync(this.path, 'utf8').trim());
      if (oldPid && this.isAlive(oldPid)) {
        throw new Error(`Worker already running (pid ${oldPid})`);
      }
    }
    writeFileSync(this.path, String(process.pid));
    this.acquired = true;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      // Only remove the lock if it still holds our PID. If another live worker
      // has since replaced the file, deleting it would strand that worker — the
      // exact failure #1 is about, now foolproof against overwrite or manual edits.
      if (existsSync(this.path)) {
        const currentPid = Number(readFileSync(this.path, 'utf8').trim());
        if (currentPid === process.pid) {
          unlinkSync(this.path);
        }
      }
    } catch {
      // ignore — best-effort; a missing or unreadable lock is fine
    }
    this.acquired = false;
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
