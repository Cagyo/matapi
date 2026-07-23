import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FsFeatureInstallRequestAdapter } from '../../../src/features/infrastructure/fs-feature-install-request.adapter';
import { FsFeatureInstallResultAdapter } from '../../../src/features/infrastructure/fs-feature-install-result.adapter';
import { SystemdFeatureInstallControllerAdapter } from '../../../src/features/infrastructure/systemd-feature-install-controller.adapter';

const JOB = 'Abcdefghijklmno_';

describe('feature install spool adapters', () => {
  it('publishes exactly one canonical request and accepts only an identical retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feature-spool-'));
    const requests = join(root, 'requests');
    await mkdir(requests);
    const adapter = new FsFeatureInstallRequestAdapter({ requestDirectory: requests });
    const request = { version: 1 as const, jobId: JOB, feature: 'digital' as const };

    await expect(adapter.publish(request)).resolves.toBe('published');
    await expect(adapter.publish(request)).resolves.toBe('already-published');
    await expect(readFile(join(requests, `${JOB}.json`), 'utf8'))
      .resolves.toBe('{"feature":"digital","jobId":"Abcdefghijklmno_","version":1}\n');
    await expect(adapter.publish({ ...request, unexpected: undefined } as never)).rejects.toThrow(RangeError);
  });

  it('treats a valid running marker as a commit barrier even when a result is visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feature-results-'));
    await writeFile(join(root, `${JOB}.running`), '{"feature":"digital","jobId":"Abcdefghijklmno_","version":1}\n', { mode: 0o640 });
    await writeFile(join(root, `${JOB}.json`), '{"failureCode":null,"feature":"digital","jobId":"Abcdefghijklmno_","outcome":"succeeded","privilegedReady":true,"restartScope":"worker","version":1}\n', { mode: 0o640 });
    const adapter = new FsFeatureInstallResultAdapter({ resultDirectory: root, expectedOwnerUid: process.getuid?.() ?? 0, expectedGroupGid: process.getgid?.() ?? 0 });

    await expect(adapter.readState(JOB, 'digital')).resolves.toEqual({ kind: 'running' });
  });

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
      ['/bin/systemctl', 'start', '--no-block', 'homeworker-feature-install.service'],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });
});
