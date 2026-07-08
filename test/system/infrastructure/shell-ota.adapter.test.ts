import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OTA_ENV_ALLOWLIST,
  ShellOtaAdapter,
  filterEnv,
} from '../../../src/system/infrastructure/shell-ota.adapter';

interface Call { file: string; args: string[] }

function fakeExec(stdoutByCmd: Record<string, string> = {}) {
  const calls: Call[] = [];
  const exec = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    return { stdout: stdoutByCmd[args.join(' ')] ?? '', stderr: '' };
  });
  return { exec, calls };
}

describe('filterEnv', () => {
  it('keeps only allowlisted keys and drops the bot token', () => {
    const out = filterEnv(
      {
        PATH: '/usr/bin',
        TELEGRAM_BOT_TOKEN: 'secret',
        DATABASE_PATH: '/db',
        HOME_WORKER_REPO: 'git@github.com:me/home-worker.git',
        HOME_WORKER_RELEASE_URL: 'https://example/r.tar.gz',
      },
      OTA_ENV_ALLOWLIST,
    );
    expect(out).toEqual({
      PATH: '/usr/bin',
      DATABASE_PATH: '/db',
      HOME_WORKER_REPO: 'git@github.com:me/home-worker.git',
      HOME_WORKER_RELEASE_URL: 'https://example/r.tar.gz',
    });
    expect(out.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});

describe('ShellOtaAdapter.checkForUpdates', () => {
  const originalPin = process.env.HOME_WORKER_GIT_BRANCH;

  afterEach(() => {
    if (originalPin === undefined) delete process.env.HOME_WORKER_GIT_BRANCH;
    else process.env.HOME_WORKER_GIT_BRANCH = originalPin;
  });

  it('compares HEAD against the branch origin/HEAD points at', async () => {
    delete process.env.HOME_WORKER_GIT_BRANCH;
    const { exec, calls } = fakeExec({
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/master\n',
      'rev-parse HEAD': 'aaa\n',
      'rev-parse origin/master': 'bbb\n',
    });

    const result = await new ShellOtaAdapter(exec).checkForUpdates();

    expect(result).toEqual({
      hasUpdates: true,
      localCommit: 'aaa',
      remoteCommit: 'bbb',
    });
    expect(calls.every((c) => c.file === 'git')).toBe(true);
  });

  it('refreshes origin/HEAD and probes master before main when unset', async () => {
    delete process.env.HOME_WORKER_GIT_BRANCH;
    const { exec, calls } = fakeExec({
      'rev-parse HEAD': 'same\n',
      'rev-parse origin/master': 'same\n',
    });

    const result = await new ShellOtaAdapter(exec).checkForUpdates();

    expect(result.hasUpdates).toBe(false);
    const joined = calls.map((c) => c.args.join(' '));
    expect(joined).toContain('remote set-head origin --auto');
    expect(joined).toContain('rev-parse --verify origin/master');
    expect(joined).not.toContain('rev-parse --verify origin/main');
  });

  it('honours HOME_WORKER_GIT_BRANCH as an explicit pin (no detection)', async () => {
    process.env.HOME_WORKER_GIT_BRANCH = 'release';
    const { exec, calls } = fakeExec({
      'rev-parse HEAD': 'aaa\n',
      'rev-parse origin/release': 'aaa\n',
    });

    const result = await new ShellOtaAdapter(exec).checkForUpdates();

    expect(result.hasUpdates).toBe(false);
    const joined = calls.map((c) => c.args.join(' '));
    expect(joined).toContain('rev-parse origin/release');
    expect(joined).not.toContain('symbolic-ref --short refs/remotes/origin/HEAD');
  });
});
