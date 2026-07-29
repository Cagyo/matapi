import { describe, expect, it } from 'vitest';
import { DriveConfigurationError } from '../../../src/archive/domain/errors/drive-configuration.error';
import { TelegramDriveClientDocumentAdapter } from '../../../src/telegram/infrastructure/telegram-drive-client-document.adapter';

describe('TelegramDriveClientDocumentAdapter', () => {
  it('aborts when streamed bytes exceed 64 KiB despite a false declared size', async () => {
    let consumed = 0;
    const reader = new TelegramDriveClientDocumentAdapter({
      async *download(_fileId, maxBytes) {
        const chunk = Buffer.alloc(maxBytes);
        consumed += chunk.length;
        yield chunk;
        consumed += 1;
        yield Buffer.alloc(1);
      },
    });

    await expect(reader.read({ fileId: 'file-1', fileSize: 100 }, new AbortController().signal))
      .rejects.toThrow(DriveConfigurationError);
    expect(consumed).toBe(64 * 1024 + 1);
  });
});
