import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Facts about a PID that tell "the worker is still running" apart from "some
 * unrelated task happens to wear that number now".
 */
export interface ProcessIdentity {
  /** Identifier that changes on every reboot; null when the platform can't say. */
  bootId(): string | null;
  /** True only for a live *process* — never for a thread of some other process. */
  isProcessAlive(pid: number): boolean;
  /** Per-process start stamp, to catch PID reuse inside one boot; null when unknown. */
  startStamp(pid: number): string | null;
}

function readProc(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Linux procfs probe; degrades to a bare existence check off Linux (dev machines). */
export const procProcessIdentity: ProcessIdentity = {
  bootId: () => readProc('/proc/sys/kernel/random/boot_id')?.trim() || null,

  isProcessAlive(pid: number): boolean {
    const status = readProc(`/proc/${pid}/status`);
    if (status !== null) {
      // kill(2) resolves thread IDs, not just processes, so a dead worker's PID
      // reads as "alive" once a libuv thread of another process inherits it.
      // Only a thread-group leader (Tgid === Pid) is a process.
      return new RegExp(String.raw`^Tgid:\s*${pid}\s*$`, 'm').test(status);
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },

  startStamp(pid: number): string | null {
    const stat = readProc(`/proc/${pid}/stat`);
    if (stat === null) return null;
    // comm (field 2) is parenthesised and may contain spaces — parse after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] ?? null; // field 22: starttime, in clock ticks since boot
  },
};

interface LockRecord {
  pid: number;
  bootId: string | null;
  startStamp: string | null;
}

/**
 * Single-instance guard. Only `release()`s a lock this instance acquired, so a
 * second worker that fails to start can never delete the running worker's lock.
 */
export class PidLockGateway {
  private acquired = false;

  constructor(
    private readonly path: string,
    private readonly identity: ProcessIdentity = procProcessIdentity,
  ) {}

  acquire(): void {
    // check-then-write below is not atomic, but PM2 runs a single instance
    // (`instances=1`), so two simultaneous starts can't race here. The bug #1
    // targets is release() deleting a lock this instance never held — the
    // `acquired` flag, not atomicity of acquire(), is what closes that.
    mkdirSync(dirname(this.path), { recursive: true });
    const holder = this.readRecord();
    if (holder && this.isStillHeldBy(holder)) {
      throw new Error(`Worker already running (pid ${holder.pid})`);
    }
    writeFileSync(this.path, JSON.stringify(this.selfRecord()));
    this.acquired = true;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      // Only remove the lock if it still holds our PID. If another live worker
      // has since replaced the file, deleting it would strand that worker — the
      // exact failure #1 is about, now foolproof against overwrite or manual edits.
      const holder = this.readRecord();
      if (holder?.pid === process.pid) {
        unlinkSync(this.path);
      }
    } catch {
      // ignore — best-effort; a missing or unreadable lock is fine
    }
    this.acquired = false;
  }

  /**
   * A recorded PID only proves a worker is running while it still names the
   * *same* process. Each check closes one way that stops being true: a reboot
   * resets the PID counter, kill(2) answers for thread IDs as well as
   * processes, and a long-lived box recycles PIDs within a single boot. Getting
   * any of these wrong wedges the worker in a restart loop it cannot escape, so
   * an unprovable claim of liveness is treated as stale.
   */
  private isStillHeldBy(holder: LockRecord): boolean {
    if (!holder.pid) return false;

    const bootId = this.identity.bootId();
    if (holder.bootId !== null && bootId !== null && holder.bootId !== bootId) return false;

    if (!this.identity.isProcessAlive(holder.pid)) return false;

    const startStamp = this.identity.startStamp(holder.pid);
    if (holder.startStamp !== null && startStamp !== null && holder.startStamp !== startStamp) {
      return false;
    }
    return true;
  }

  private selfRecord(): LockRecord {
    return {
      pid: process.pid,
      bootId: this.identity.bootId(),
      startStamp: this.identity.startStamp(process.pid),
    };
  }

  /** Reads the lock, tolerating the legacy bare-PID files written before #2. */
  private readRecord(): LockRecord | null {
    if (!existsSync(this.path)) return null;

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8').trim();
    } catch {
      return null;
    }
    if (!raw) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as Partial<LockRecord>;
        return {
          pid: Number(record.pid) || 0,
          bootId: typeof record.bootId === 'string' ? record.bootId : null,
          startStamp: typeof record.startStamp === 'string' ? record.startStamp : null,
        };
      }
    } catch {
      // not JSON — fall through to the legacy bare-PID format
    }
    return { pid: Number(raw) || 0, bootId: null, startStamp: null };
  }
}
