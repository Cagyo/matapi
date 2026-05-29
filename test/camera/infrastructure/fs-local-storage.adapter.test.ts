import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

    await adapter.deleteFile(file);
    expect(existsSync(file)).toBe(false);

    // second delete must not throw
    await expect(adapter.deleteFile(file)).resolves.toBeUndefined();
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
});
