import { describe, expect, it } from 'vitest';
import { FsArchiveUploadSourceAdapter } from '../../../src/archive/infrastructure/persistence/fs-archive-upload-source.adapter';

describe('FsArchiveUploadSourceAdapter', () => {
  it('maps a path-bearing stat failure to a sanitized allowlisted code', async () => {
    const secretPath = '/private/motion/secret-video.avi';
    const adapter = new FsArchiveUploadSourceAdapter();

    await expect(adapter.stat(secretPath, new AbortController().signal)).rejects.toMatchObject({
      name: 'ArchiveSourceFilesystemError',
      code: 'archive_source_missing',
      operation: 'stat',
      message: 'Archive source filesystem operation failed',
    });
    await expect(adapter.stat(secretPath, new AbortController().signal)).rejects.not.toThrow(secretPath);
  });

  it('maps a path-bearing stream-open failure before it crosses the application boundary', async () => {
    const secretPath = '/private/motion/secret-video.mkv';
    const adapter = new FsArchiveUploadSourceAdapter();
    const consume = async () => {
      for await (const _part of adapter.open(
        secretPath, 0, 1, new AbortController().signal,
      )) {
        // Consume the boundary so a lazy stream-open failure is observed.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: 'ArchiveSourceFilesystemError',
      code: 'archive_source_missing',
      operation: 'read',
      message: 'Archive source filesystem operation failed',
    });
    await expect(consume()).rejects.not.toThrow(secretPath);
  });
});
