import { mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationLogUnavailableError } from '../../../src/system/domain/errors/application-log-unavailable.error';
import { BoundedLogTailGateway } from '../../../src/system/infrastructure/bounded-log-tail.gateway';

describe('BoundedLogTailGateway', () => {
  const roots: string[] = [];

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(name: string, bytes: string | Buffer): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'home-worker-app-log-'));
    roots.push(root);
    const path = join(root, name);
    await writeFile(path, bytes);
    return path;
  }

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid chunk size %s synchronously', (chunkBytes) => {
    expect(() => new BoundedLogTailGateway(chunkBytes)).toThrow(
      new RangeError('chunkBytes must be a positive safe integer'),
    );
  });

  it('returns the newest complete LF-delimited lines in chronological order', async () => {
    const path = await fixture('worker-out.log', 'one\r\ntwo\nthree');
    const result = await new BoundedLogTailGateway().read({ path, maxLines: 2, maxBytes: 1024 });
    expect(result.lines.map((line) => line.toString('utf8'))).toEqual(['two', 'three']);
    expect(result.truncatedByByteLimit).toBe(false);
  });

  it('treats an empty file as zero lines and a trailing LF as no synthetic empty line', async () => {
    const empty = await fixture('empty.log', Buffer.alloc(0));
    const ended = await fixture('ended.log', 'one\ntwo\n');
    const gateway = new BoundedLogTailGateway();
    await expect(gateway.read({ path: empty, maxLines: 200, maxBytes: 1024 }))
      .resolves.toMatchObject({ lines: [] });
    const endedResult = await gateway.read({ path: ended, maxLines: 200, maxBytes: 1024 });
    expect(endedResult.lines.map((line) => line.toString())).toEqual(['one', 'two']);
  });

  it('drops an oldest partial line at the raw-byte boundary', async () => {
    const path = await fixture('bounded.log', 'older-line\nkeep-1\nkeep-2');
    const result = await new BoundedLogTailGateway(8).read({ path, maxLines: 200, maxBytes: 13 });
    expect(result.lines.map((line) => line.toString())).toEqual(['keep-1', 'keep-2']);
    expect(result.truncatedByByteLimit).toBe(true);
  });

  it('marks byte truncation when the whole file is read in one chunk', async () => {
    const path = await fixture('same-chunk.log', '1234567890\nz');
    const result = await new BoundedLogTailGateway().read({ path, maxLines: 200, maxBytes: 10 });
    expect(result.lines.map((line) => line.toString())).toEqual(['z']);
    expect(result.truncatedByByteLimit).toBe(true);
  });

  it('rejects a symlink and a newest raw line larger than the bound', async () => {
    const target = await fixture('target.log', 'secret');
    const link = `${target}.link`;
    await symlink(target, link);
    const gateway = new BoundedLogTailGateway();
    await expect(gateway.read({ path: link, maxLines: 200, maxBytes: 1024 }))
      .rejects.toMatchObject({ reason: 'file-unavailable' });
    await expect(gateway.read({ path: target, maxLines: 200, maxBytes: 3 }))
      .rejects.toEqual(new ApplicationLogUnavailableError('snapshot-too-large'));
  });

  it('stays on the opened inode when the pathname is rotated', async () => {
    const path = await fixture('rotate.log', 'before');
    const rotated = `${path}.1`;
    const gateway = new BoundedLogTailGateway(64, async (selected, flags) => {
      const { open } = await import('node:fs/promises');
      const handle = await open(selected, flags);
      await rename(path, rotated);
      await writeFile(path, 'after');
      return handle;
    });
    const result = await gateway.read({ path, maxLines: 200, maxBytes: 1024 });
    expect(result.lines.map((line) => line.toString())).toEqual(['before']);
  });

  it('maps a short positioned read to snapshot-changed and closes the handle', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = {
      stat: vi.fn().mockResolvedValue({ size: 4, isFile: () => true }),
      read: vi.fn().mockResolvedValue({ bytesRead: 2, buffer: Buffer.alloc(4) }),
      close,
    };
    const gateway = new BoundedLogTailGateway(
      4,
      vi.fn().mockResolvedValue(handle),
    );

    await expect(gateway.read({ path: '/fixed/log', maxLines: 200, maxBytes: 1024 }))
      .rejects.toMatchObject({ reason: 'snapshot-changed' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps descriptor stat failures after opening to file-unavailable', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = {
      stat: vi.fn()
        .mockResolvedValueOnce({ size: 4, isFile: () => true })
        .mockRejectedValueOnce(new Error('descriptor stat failed')),
      read: vi.fn(),
      close,
    };
    const gateway = new BoundedLogTailGateway(4, vi.fn().mockResolvedValue(handle));

    await expect(gateway.read({ path: '/fixed/log', maxLines: 200, maxBytes: 1024 }))
      .rejects.toMatchObject({ reason: 'file-unavailable' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps descriptor read failures after opening to file-unavailable', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = {
      stat: vi.fn().mockResolvedValue({ size: 4, isFile: () => true }),
      read: vi.fn().mockRejectedValue(new Error('descriptor read failed')),
      close,
    };
    const gateway = new BoundedLogTailGateway(4, vi.fn().mockResolvedValue(handle));

    await expect(gateway.read({ path: '/fixed/log', maxLines: 200, maxBytes: 1024 }))
      .rejects.toMatchObject({ reason: 'file-unavailable' });
    expect(close).toHaveBeenCalledOnce();
  });
});
