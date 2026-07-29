import { mkdtemp, mkdir, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsCompletedMotionVideoAdapter } from '../../../src/camera/infrastructure/fs-completed-motion-video.adapter';

describe('FsCompletedMotionVideoAdapter', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })),
    ));
  });

  async function fixture(name = '120000-12345.mp4'): Promise<{
    root: string;
    file: string;
    adapter: FsCompletedMotionVideoAdapter;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-'));
    directories.push(root);
    const directory = join(root, '2026', '07', '29');
    await mkdir(directory, { recursive: true });
    const file = join(directory, name);
    await writeFile(file, 'completed video');
    const stableAt = new Date(Date.now() - 61_000);
    await utimes(file, stableAt, stableAt);
    return {
      root,
      file,
      adapter: new FsCompletedMotionVideoAdapter({ root, now: () => Date.now() }),
    };
  }

  it.each(['empty', 'symlink', 'outside-root', 'partial', 'unexpected-extension', 'unstable'])(
    'rejects %s candidates',
    async (kind) => {
      const { root, file, adapter } = await fixture();
      if (kind === 'empty') await writeFile(file, '');
      if (kind === 'symlink') {
        const target = join(root, 'target.mp4');
        await writeFile(target, 'completed video');
        await unlink(file);
        await symlink(target, file);
      }
      if (kind === 'outside-root') {
        const outside = join(tmpdir(), `outside-${Date.now()}.mp4`);
        directories.push(outside);
        await writeFile(outside, 'completed video');
        expect(await adapter.resolve(outside)).toBeNull();
        return;
      }
      if (kind === 'partial') {
        const partial = join(root, '2026', '07', '29', '120000-12345.mp4.part');
        await writeFile(partial, 'completed video');
        expect(await adapter.resolve(partial)).toBeNull();
        return;
      }
      if (kind === 'unexpected-extension') {
        const other = join(root, '2026', '07', '29', '120000-12345.txt');
        await writeFile(other, 'completed video');
        expect(await adapter.resolve(other)).toBeNull();
        return;
      }
      if (kind === 'unstable') await utimes(file, new Date(), new Date());

      expect(await adapter.resolve(file)).toBeNull();
    },
  );

  it('returns a stable descriptor with a bounded SHA-256 fingerprint', async () => {
    const { file, adapter } = await fixture();

    const descriptor = await adapter.resolve(file);

    expect(descriptor).toMatchObject({
      kind: 'motion_video',
      size: 'completed video'.length,
      relativePath: '2026/07/29/120000-12345.mp4',
    });
    expect(descriptor?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
