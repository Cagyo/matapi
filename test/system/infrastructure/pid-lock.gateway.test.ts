import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PidLockGateway } from '../../../src/system/infrastructure/pid-lock.gateway';

const dir = resolve('test/.tmp/pid-lock');
const lockPath = resolve(dir, 'worker.pid');

describe('PidLockGateway', () => {
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
});
