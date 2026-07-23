import { constants } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  link: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMocks);

import { SystemdFeatureInstallControllerAdapter } from '../../../src/features/infrastructure/systemd-feature-install-controller.adapter';
import { FsFeatureInstallRequestAdapter } from '../../../src/features/infrastructure/fs-feature-install-request.adapter';
import { FsFeatureInstallResultAdapter } from '../../../src/features/infrastructure/fs-feature-install-result.adapter';
import { validateSpoolDirectory } from '../../../src/features/infrastructure/fs-feature-install-request.adapter';

const JOB = 'abcdefghijklmnop';
const request = `{"feature":"digital","jobId":"${JOB}","version":1}\n`;
const terminal = `{"failureCode":null,"feature":"digital","jobId":"${JOB}","outcome":"succeeded","privilegedReady":true,"restartScope":"worker","version":1}\n`;

function fileHandle(content: string, overrides: Partial<{ isFile(): boolean; uid: number; gid: number; mode: number; nlink: number; size: number }> = {}) {
  const value = {
    isFile: () => true,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    mode: 0o100600,
    nlink: 1,
    size: Buffer.byteLength(content),
    ...overrides,
  };
  return {
    stat: vi.fn(async () => value),
    read: vi.fn(async (buffer: Buffer) => ({ bytesRead: buffer.write(content) })),
    writeFile: vi.fn(async () => undefined), chmod: vi.fn(async () => undefined), sync: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
}

function directoryHandle() {
  return { stat: vi.fn(async () => ({ isDirectory: () => true, uid: 0, gid: process.getgid?.() ?? 0, mode: 0o40770 })), sync: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
}

describe('feature install spool adapters', () => {
  it('can start only the fixed installer unit without a shell', async () => {
    const execFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      done: (error: Error | null) => void,
    ) => done(null));
    await new SystemdFeatureInstallControllerAdapter(execFile).start();
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/bin/systemctl', 'start', '--no-block', 'homeworker-feature-install.service'],
      expect.objectContaining({ shell: false, timeout: 15_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } }),
      expect.any(Function),
    );
  });

  it('publishes only to fixed paths, makes identical retries idempotent, and rejects a collision', async () => {
    const flags: number[] = [];
    fsMocks.open.mockImplementation(async (path: string, openFlags: number) => {
      flags.push(openFlags);
      if (path === '/var/lib/home-worker/feature-install-requests' && (openFlags & constants.O_DIRECTORY)) return directoryHandle();
      if (path.includes('.tmp')) return fileHandle('');
      return fileHandle(request);
    });
    fsMocks.link.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' })).mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    fsMocks.unlink.mockResolvedValue(undefined);
    const adapter = new FsFeatureInstallRequestAdapter();
    await expect(adapter.publish({ version: 1, jobId: JOB, feature: 'digital' })).resolves.toBe('published');
    await expect(adapter.publish({ version: 1, jobId: JOB, feature: 'digital' })).resolves.toBe('already-published');
    fsMocks.open.mockImplementation(async (path: string, openFlags: number) => {
      flags.push(openFlags);
      if (path === '/var/lib/home-worker/feature-install-requests' && (openFlags & constants.O_DIRECTORY)) return directoryHandle();
      if (path.includes('.tmp')) return fileHandle('');
      return fileHandle(request.replace('digital', 'rtsp'));
    });
    await expect(adapter.publish({ version: 1, jobId: JOB, feature: 'digital' })).rejects.toThrow('conflicts');
    expect(fsMocks.open).toHaveBeenCalledWith('/var/lib/home-worker/feature-install-requests', expect.any(Number));
  });

  it('honors a valid marker before a terminal result and fails closed for hostile result entries', async () => {
    const flags: number[] = [];
    const configure = (content: string, overrides = {}) => fsMocks.open.mockImplementation(async (_path: string, openFlags: number) => {
      flags.push(openFlags);
      if (_path === '/var/lib/home-worker/feature-install-results' && (openFlags & constants.O_DIRECTORY)) return directoryHandle();
      return fileHandle(content, overrides);
    });
    configure(request, { uid: 0, gid: process.getgid?.() ?? 0, mode: 0o100640 });
    const adapter = new FsFeatureInstallResultAdapter();
    await expect(validateSpoolDirectory('/var/lib/home-worker/feature-install-results', 0, process.getgid?.() ?? 0, 0o770)).resolves.toBeUndefined();
    await expect(adapter.readState(JOB, 'digital')).resolves.toEqual({ kind: 'running' });
    expect(flags.some((value) => (value & constants.O_NONBLOCK) !== 0 && (value & constants.O_NOFOLLOW) !== 0)).toBe(true);
    for (const overrides of [
      { uid: 1 }, { gid: 1 }, { mode: 0o100600 }, { nlink: 2 }, { isFile: () => false }, { size: 4097 },
    ]) {
      configure(terminal, overrides);
      await expect(adapter.readState(JOB, 'digital')).rejects.toThrow('result-invalid');
    }
    configure(`{"feature":"rtsp","jobId":"${JOB}","version":1}\n`, { uid: 0, gid: process.getgid?.() ?? 0, mode: 0o100640 });
    await expect(adapter.readState(JOB, 'digital')).rejects.toThrow('result-invalid');
  });

  it('cancels only an exact request that the root helper has not claimed', async () => {
    fsMocks.open.mockImplementation(async (path: string, openFlags: number) => {
      if (path === '/var/lib/home-worker/feature-install-requests' && (openFlags & constants.O_DIRECTORY)) return directoryHandle();
      return fileHandle(request);
    });
    fsMocks.rename.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
    const adapter = new FsFeatureInstallRequestAdapter();

    await expect(adapter.cancelUnclaimed({ version: 1, jobId: JOB, feature: 'digital' })).resolves.toBe(true);
    fsMocks.rename.mockRejectedValueOnce(Object.assign(new Error('claimed'), { code: 'ENOENT' }));
    await expect(adapter.cancelUnclaimed({ version: 1, jobId: JOB, feature: 'digital' })).resolves.toBe(false);
  });
});
