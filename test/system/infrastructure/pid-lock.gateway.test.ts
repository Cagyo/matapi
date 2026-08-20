import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PidLockGateway,
  procProcessIdentity,
  type ProcessIdentity,
} from '../../../src/system/infrastructure/pid-lock.gateway';

const dir = resolve('test/.tmp/pid-lock');
const lockPath = resolve(dir, 'worker.pid');

/** Default probe = a live holder in the current boot; override one fact per test. */
const probe = (overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
  bootId: () => 'boot-A',
  isProcessAlive: () => true,
  startStamp: () => '1291',
  ...overrides,
});

describe('PidLockGateway', () => {
  beforeEach(() => mkdirSync(dir, { recursive: true }));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('acquires then releases the lockfile', () => {
    const lock = new PidLockGateway(lockPath);
    lock.acquire();
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('throws when a live lock is already held', () => {
    new PidLockGateway(lockPath).acquire(); // holder = this test process (alive)
    expect(() => new PidLockGateway(lockPath).acquire()).toThrow(/already running/);
  });

  it('release() never deletes a lock it did not acquire', () => {
    const holder = new PidLockGateway(lockPath);
    holder.acquire();

    const loser = new PidLockGateway(lockPath);
    expect(() => loser.acquire()).toThrow(/already running/);
    loser.release(); // must be a no-op

    expect(existsSync(lockPath)).toBe(true); // holder's lock survives
    holder.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release() leaves the lock alone if another worker has replaced it', () => {
    const worker = new PidLockGateway(lockPath);
    worker.acquire(); // writes our PID, acquired = true

    // Another live worker replaces the lockfile after we acquired it.
    writeFileSync(lockPath, String(process.pid + 1));
    worker.release(); // acquired is true, but the PID on disk is no longer ours

    expect(existsSync(lockPath)).toBe(true); // must not delete the other worker's lock
  });

  describe('stale-lock recovery', () => {
    it('still refuses to start while the recorded holder is genuinely alive', () => {
      new PidLockGateway(lockPath, probe()).acquire();
      expect(() => new PidLockGateway(lockPath, probe()).acquire()).toThrow(/already running/);
    });

    it('treats a lock written in a previous boot as stale', () => {
      new PidLockGateway(lockPath, probe({ bootId: () => 'boot-A' })).acquire();

      // After a reboot the PID counter restarts, so the recorded PID says nothing.
      const afterReboot = new PidLockGateway(lockPath, probe({ bootId: () => 'boot-B' }));
      expect(() => afterReboot.acquire()).not.toThrow();
    });

    it('treats a lock whose PID no longer names a live process as stale', () => {
      new PidLockGateway(lockPath, probe()).acquire();

      const next = new PidLockGateway(lockPath, probe({ isProcessAlive: () => false }));
      expect(() => next.acquire()).not.toThrow();
    });

    it('treats a lock whose PID was recycled by another process as stale', () => {
      new PidLockGateway(lockPath, probe({ startStamp: () => '1291' })).acquire();

      // Same boot, PID alive again — but it is a different process wearing that PID.
      const recycled = new PidLockGateway(lockPath, probe({ startStamp: () => '65386' }));
      expect(() => recycled.acquire()).not.toThrow();
    });

    it('recovers from the production wedge: pre-reboot lock whose PID became a PM2 thread', () => {
      // Boot A: worker 1129 holds the lock, then dies without release() (power cut).
      new PidLockGateway(
        lockPath,
        probe({ bootId: () => 'boot-A', startStamp: () => '1291' }),
      ).acquire();

      // Boot B: PID 1129 is now a libuv *thread* of the PM2 daemon, so kill(1129, 0)
      // succeeds and the old guard wedged the worker in a restart loop forever.
      const afterReboot = new PidLockGateway(
        lockPath,
        probe({
          bootId: () => 'boot-B',
          isProcessAlive: () => false,
          startStamp: () => '65386',
        }),
      );
      expect(() => afterReboot.acquire()).not.toThrow();
      expect(readFileSync(lockPath, 'utf8')).toContain(String(process.pid));
    });
  });

  describe('legacy bare-PID lockfiles', () => {
    it('still refuses to start when a legacy lock names a live process', () => {
      writeFileSync(lockPath, String(process.pid));
      expect(() => new PidLockGateway(lockPath, probe()).acquire()).toThrow(/already running/);
    });

    it('treats a legacy lock as stale when the PID is not a live process', () => {
      writeFileSync(lockPath, '1129');
      const lock = new PidLockGateway(lockPath, probe({ isProcessAlive: () => false }));
      expect(() => lock.acquire()).not.toThrow();
    });
  });

  describe('procProcessIdentity', () => {
    it.runIf(process.platform === 'linux')('reports a thread ID as not a live process', () => {
      const tids = readdirSync('/proc/self/task')
        .map(Number)
        .filter((tid) => tid !== process.pid);
      expect(tids.length).toBeGreaterThan(0); // Node always runs libuv threads

      const tid = tids[0];
      // The trap this whole guard exists to survive: kill(2) resolves thread IDs,
      // so process.kill(tid, 0) succeeds even though `tid` is not a process.
      expect(() => process.kill(tid, 0)).not.toThrow();
      expect(procProcessIdentity.isProcessAlive(tid)).toBe(false);
      expect(procProcessIdentity.isProcessAlive(process.pid)).toBe(true);
    });

    it.runIf(process.platform === 'linux')('reports a stable boot id and start stamp', () => {
      expect(procProcessIdentity.bootId()).toMatch(/^[0-9a-f-]{36}$/);
      expect(procProcessIdentity.startStamp(process.pid)).toMatch(/^\d+$/);
    });

    it('reports dead PIDs as not alive', () => {
      expect(procProcessIdentity.isProcessAlive(0x7ffffff)).toBe(false);
    });
  });
});
