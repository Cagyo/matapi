import { mkdtemp, mkdir, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsCompletedMotionVideoAdapter } from '../../../src/camera/infrastructure/fs-completed-motion-video.adapter';
import { canonicalSourceFingerprintInput } from '../../../src/archive/domain/archive-artifact.entity';

const installationId = '00000000-0000-4000-8000-000000000001';

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
      adapter: new FsCompletedMotionVideoAdapter({ root, now: () => Date.now(), installationId }),
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
    expect(descriptor?.sourceFingerprint).toBe(createHash('sha256').update(
      canonicalSourceFingerprintInput({
        installationId,
        kind: 'motion_video',
        relativePath: '2026/07/29/120000-12345.mp4',
        size: 'completed video'.length,
        mtimeNs: descriptor!.mtimeNs,
        sha256: descriptor!.sha256,
      }),
      'utf8',
    ).digest('hex'));
  });

  it('fails closed when production installation identity is missing or malformed', async () => {
    const { root, file } = await fixture();

    expect(await new FsCompletedMotionVideoAdapter({ root, now: () => Date.now() }).resolve(file)).toBeNull();
    expect(await new FsCompletedMotionVideoAdapter({ root, now: () => Date.now(), installationId: 'not-a-uuid' }).resolve(file)).toBeNull();
  });

  it('rejects a same-size, same-mtime replacement after hashing', async () => {
    const { root, file } = await fixture();
    const original = await import('node:fs/promises').then(({ stat }) => stat(file));
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId,
      afterHash: async () => {
        const moved = `${file}.old`;
        await rename(file, moved);
        await writeFile(file, 'different video');
        await utimes(file, original.atime, original.mtime);
      },
    });

    expect(await adapter.resolve(file)).toBeNull();
  });

  it('rejects a Motion-root swap after hashing', async () => {
    const { root, file } = await fixture();
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId,
      afterHash: async () => {
        await rename(root, `${root}.old`);
        await mkdir(join(root, '2026', '07', '29'), { recursive: true });
        await writeFile(join(root, '2026', '07', '29', '120000-12345.mp4'), 'completed video');
      },
    });

    expect(await adapter.resolve(file)).toBeNull();
  });

  it('rotates bounded scan work so later entries are eventually observed', async () => {
    const { root } = await fixture('120000-first.mp4');
    const directory = join(root, '2026', '07', '29');
    const second = join(directory, '120001-second.mp4');
    await writeFile(second, 'completed video');
    const stableAt = new Date(Date.now() - 61_000);
    await utimes(second, stableAt, stableAt);
    const adapter = new FsCompletedMotionVideoAdapter({
      root, now: () => Date.now(), installationId, scanMultiplier: 1,
    });

    const observed = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      (await adapter.scan(1)).forEach((descriptor) => observed.add(descriptor.relativePath));
    }

    expect(observed).toEqual(new Set([
      '2026/07/29/120000-first.mp4',
      '2026/07/29/120001-second.mp4',
    ]));
  });
});
