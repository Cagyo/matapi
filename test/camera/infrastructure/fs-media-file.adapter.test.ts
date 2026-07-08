import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsMediaFileAdapter } from '../../../src/camera/infrastructure/fs-media-file.adapter';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('FsMediaFileAdapter.mtimeMs', () => {
  it('returns the file mtime in epoch milliseconds', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-file-'));
    const file = join(dir, 'clip.mp4');
    const before = Date.now();
    await writeFile(file, 'x');

    const mtime = await new FsMediaFileAdapter().mtimeMs(file);

    expect(mtime).not.toBeNull();
    expect(mtime!).toBeGreaterThanOrEqual(before - 1000);
    expect(mtime!).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('returns null for a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-file-'));

    const mtime = await new FsMediaFileAdapter().mtimeMs(join(dir, 'nope.mp4'));

    expect(mtime).toBeNull();
  });
});
