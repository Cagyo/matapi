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
    expect(descriptor?.sourceTimeMs).toBe(Date.UTC(2026, 6, 29, 12, 0, 0));
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

  it('advances an explicit cursor through an invalid-only batch', async () => {
    const { root, adapter } = await fixture();
    await unlink(join(root, '2026', '07', '29', '120000-12345.mp4'));
    const directory = join(root, 'invalid');
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 80; index += 1) {
      await writeFile(join(directory, `${String(index).padStart(3, '0')}.txt`), 'invalid');
    }

    const first = await adapter.scanBatch({ cursor: null, entryLimit: 64 });
    expect(first.descriptors).toEqual([]);
    expect(first.visitedEntries).toBe(64);
    expect(first.complete).toBe(false);
    expect(first.cursor).not.toBeNull();

    const input = first.cursor!;
    const snapshot = structuredClone(input);
    const second = await adapter.scanBatch({ cursor: input, entryLimit: 64 });
    expect(input).toEqual(snapshot);
    expect(second.descriptors).toEqual([]);
    expect(second.complete).toBe(true);
    expect(second.cursor).toBeNull();
  });

  it('rejects resumed cursor components that could escape the Motion root', async () => {
    const { root, adapter } = await fixture();
    const outside = `${root}-outside`;
    directories.push(outside);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'outside.txt'), 'must not be visited');
    await mkdir(join(root, 'inside'), { recursive: true });

    for (const relativeDirectory of [
      'inside/../../' + outside.split('/').at(-1),
      'inside/../2026',
      'inside//child',
      './2026',
    ]) {
      const batch = await adapter.scanBatch({
        cursor: { frames: [{ relativeDirectory, nextEntry: 0 }] },
        entryLimit: 64,
      });
      expect(batch).toEqual({
        descriptors: [],
        cursor: null,
        complete: true,
        visitedEntries: 0,
      });
    }
  });

  it('enforces a hard 64-entry boundary when callers request a larger batch', async () => {
    const { root, adapter } = await fixture();
    await unlink(join(root, '2026', '07', '29', '120000-12345.mp4'));
    const directory = join(root, 'invalid');
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(directory, `${String(index).padStart(3, '0')}.txt`), 'invalid');
    }

    const batch = await adapter.scanBatch({ cursor: null, entryLimit: 1_000 });

    expect(batch.visitedEntries).toBe(64);
    expect(batch.complete).toBe(false);
    expect(batch.cursor).not.toBeNull();
  });

  it('returns valid descriptors while invalid and unstable entries still consume traversal budget', async () => {
    const { root } = await fixture('120000-first.mp4');
    const directory = join(root, '2026', '07', '29');
    const valid = join(directory, '120001-second.mkv');
    const unstable = join(directory, '120002-third.avi');
    await writeFile(valid, 'second video');
    await writeFile(unstable, 'unstable video');
    await writeFile(join(directory, 'notes.txt'), 'invalid');
    const stableAt = new Date(Date.now() - 61_000);
    await utimes(valid, stableAt, stableAt);
    const adapter = new FsCompletedMotionVideoAdapter({ root, now: () => Date.now(), installationId });

    const observed: string[] = [];
    let cursor = null;
    let complete = false;
    while (!complete) {
      const batch = await adapter.scanBatch({ cursor, entryLimit: 2 });
      observed.push(...batch.descriptors.map((candidate) => candidate.relativePath));
      cursor = batch.cursor;
      complete = batch.complete;
      expect(batch.visitedEntries).toBeLessThanOrEqual(2);
    }

    expect(observed).toEqual([
      '2026/07/29/120000-first.mp4',
      '2026/07/29/120001-second.mkv',
    ]);
  });

  it('hashes large files sequentially and accepts the full bytes', async () => {
    const { root, file } = await fixture();
    const directory = join(root, '2026', '07', '29');
    const second = join(directory, '120001-second.mp4');
    const bytes = Buffer.alloc((64 * 1024 * 2) + 17, 0x5a);
    await writeFile(file, bytes);
    await writeFile(second, bytes);
    const stableAt = new Date(Date.now() - 61_000);
    await utimes(file, stableAt, stableAt);
    await utimes(second, stableAt, stableAt);
    let active = 0;
    let maximum = 0;
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId,
      afterHash: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
      },
    });

    let cursor = null;
    const descriptors = [];
    let complete = false;
    while (!complete) {
      const batch = await adapter.scanBatch({ cursor, entryLimit: 64 });
      descriptors.push(...batch.descriptors);
      cursor = batch.cursor;
      complete = batch.complete;
    }

    expect(maximum).toBe(1);
    expect(descriptors).toHaveLength(2);
    expect(descriptors.every((candidate) => candidate.sha256 === createHash('sha256').update(bytes).digest('hex'))).toBe(true);
  });

  it('leaves files inserted behind the cursor for the next traversal', async () => {
    const { root, adapter } = await fixture();
    const directory = join(root, '2026', '07', '29');
    for (let index = 1; index <= 70; index += 1) {
      await writeFile(join(directory, `${String(120000 + index).padStart(6, '0')}-video.mp4`), 'video');
    }
    const stableAt = new Date(Date.now() - 61_000);
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    await Promise.all(files.map((name) => utimes(join(directory, name), stableAt, stableAt)));

    const first = await adapter.scanBatch({ cursor: null, entryLimit: 64 });
    const inserted = join(root, '2025', '01', '01', '000000-inserted.mp4');
    await mkdir(join(root, '2025', '01', '01'), { recursive: true });
    await writeFile(inserted, 'inserted');
    await utimes(inserted, stableAt, stableAt);

    const currentTraversal: string[] = [...first.descriptors.map((candidate) => candidate.relativePath)];
    let cursor = first.cursor;
    let complete = first.complete;
    while (!complete) {
      const batch = await adapter.scanBatch({ cursor, entryLimit: 64 });
      currentTraversal.push(...batch.descriptors.map((candidate) => candidate.relativePath));
      cursor = batch.cursor;
      complete = batch.complete;
    }
    expect(currentTraversal).not.toContain('2025/01/01/000000-inserted.mp4');

    const nextTraversal: string[] = [];
    cursor = null;
    complete = false;
    while (!complete) {
      const batch = await adapter.scanBatch({ cursor, entryLimit: 64 });
      nextTraversal.push(...batch.descriptors.map((candidate) => candidate.relativePath));
      cursor = batch.cursor;
      complete = batch.complete;
    }
    expect(nextTraversal).toContain('2025/01/01/000000-inserted.mp4');
  });
});
