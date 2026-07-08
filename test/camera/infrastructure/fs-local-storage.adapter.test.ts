import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsLocalStorageAdapter } from '../../../src/camera/infrastructure/fs-local-storage.adapter';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'motion-'));
  process.env.MOTION_LOCAL_DIR = root;
});

afterEach(() => {
  delete process.env.MOTION_LOCAL_DIR;
});

describe('FsLocalStorageAdapter', () => {
  it('reports a usage percent between 0 and 100 via df', async () => {
    const usage = await new FsLocalStorageAdapter().usagePercent();
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThanOrEqual(100);
  });

  it('deletes a file and treats a missing file as already gone', async () => {
    const file = join(root, 'clip.mp4');
    await writeFile(file, 'x');
    const adapter = new FsLocalStorageAdapter();

    await expect(adapter.deleteFile(file)).resolves.toBe(true);
    expect(existsSync(file)).toBe(false);

    // second delete must not throw — already-absent counts as deleted
    await expect(adapter.deleteFile(file)).resolves.toBe(true);
  });

  it('prunes empty subdirectories but keeps the root and non-empty dirs', async () => {
    const emptyDir = join(root, '2026', '04', '08');
    await mkdir(emptyDir, { recursive: true });
    const keepDir = join(root, '2026', '05');
    await mkdir(keepDir, { recursive: true });
    await writeFile(join(keepDir, 'clip.mp4'), 'x');

    await new FsLocalStorageAdapter().pruneEmptyDirs();

    expect(existsSync(emptyDir)).toBe(false);
    expect(existsSync(join(root, '2026', '04'))).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('returns false when deleteFile cannot remove the path', async () => {
    const subdir = join(root, 'not-a-file');
    await mkdir(subdir);

    await expect(new FsLocalStorageAdapter().deleteFile(subdir)).resolves.toBe(false);
  });

  it('lists only files older than the cutoff, recursively', async () => {
    await mkdir(join(root, '2026/01/01'), { recursive: true });
    const oldFile = join(root, '2026/01/01/120000.mp4');
    const newFile = join(root, '2026/01/01/120100.mp4');
    await writeFile(oldFile, 'x');
    await writeFile(newFile, 'x');
    const tenDaysAgoSec = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(oldFile, tenDaysAgoSec, tenDaysAgoSec);

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const files = await new FsLocalStorageAdapter().listFilesOlderThan(cutoff);

    expect(files.map((f) => f.path)).toEqual([oldFile]);
    expect(files[0].mtimeMs).toBeLessThan(cutoff.getTime());
    expect(files[0].ctimeMs).toBeGreaterThan(0);
  });

  it('returns an empty list when the directory is missing', async () => {
    process.env.MOTION_LOCAL_DIR = '/nonexistent/motion/dir';

    const files = await new FsLocalStorageAdapter().listFilesOlderThan(new Date());

    expect(files).toEqual([]);
  });
});
