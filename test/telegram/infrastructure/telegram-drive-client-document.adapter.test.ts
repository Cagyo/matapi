import { describe, expect, it, vi } from 'vitest';
import { DriveClientDocumentError } from '../../../src/archive/domain/errors/drive-client-document.error';
import {
  MAX_DRIVE_CLIENT_DOCUMENT_BYTES,
  TelegramDriveClientDocumentAdapter,
  TelegramHttpDriveClientDocumentGateway,
} from '../../../src/telegram/infrastructure/telegram-drive-client-document.adapter';

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

const signal = new AbortController().signal;

describe('TelegramDriveClientDocumentAdapter', () => {
  it.each([
    [{ fileId: 'f', fileSize: 64 * 1024 + 1 }, 'too-large'],
    [{ fileId: '', fileSize: 1 }, 'download-failed'],
  ] as const)('classifies invalid metadata', async (document, reason) => {
    const adapter = new TelegramDriveClientDocumentAdapter({ download: vi.fn() });

    await expect(adapter.read(document, signal)).rejects.toMatchObject({ reason });
  });

  it('rejects a range-respecting oversized file from Content-Range total', async () => {
    const adapter = new TelegramDriveClientDocumentAdapter({
      download: vi.fn().mockResolvedValue({ chunks: chunks(Buffer.from('{}')), totalBytes: 65_537 }),
    });

    await expect(adapter.read({ fileId: 'f' }, signal)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('rejects the 65,537th streamed byte', async () => {
    const adapter = new TelegramDriveClientDocumentAdapter({
      download: vi.fn().mockResolvedValue({ chunks: chunks(Buffer.alloc(65_537)), totalBytes: null }),
    });

    await expect(adapter.read({ fileId: 'f' }, signal)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('rejects invalid UTF-8 without replacement decoding', async () => {
    const adapter = new TelegramDriveClientDocumentAdapter({
      download: vi.fn().mockResolvedValue({ chunks: chunks(Uint8Array.from([0xc3, 0x28])), totalBytes: 2 }),
    });

    await expect(adapter.read({ fileId: 'f' }, signal)).rejects.toMatchObject({ reason: 'invalid-utf8' });
  });

  it('accepts exactly 64 KiB even when no total is available', async () => {
    const bytes = Buffer.alloc(MAX_DRIVE_CLIENT_DOCUMENT_BYTES, 0x61);
    const adapter = new TelegramDriveClientDocumentAdapter({
      download: vi.fn().mockResolvedValue({ chunks: chunks(bytes), totalBytes: null }),
    });

    await expect(adapter.read({ fileId: 'f', fileSize: 1 }, signal)).resolves.toBe(bytes.toString('utf8'));
  });

  it('preserves caller cancellation', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);
    const adapter = new TelegramDriveClientDocumentAdapter({ download: vi.fn() });

    await expect(adapter.read({ fileId: 'f' }, controller.signal)).rejects.toBe(reason);
  });

  it('preserves the caller abort reason when cancellation races a download failure', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    const adapter = new TelegramDriveClientDocumentAdapter({
      download: async () => {
        controller.abort(reason);
        throw new Error('provider download response');
      },
    });

    await expect(adapter.read({ fileId: 'f' }, controller.signal)).rejects.toBe(reason);
  });

  it('sanitizes download failures', async () => {
    const adapter = new TelegramDriveClientDocumentAdapter({
      download: vi.fn().mockRejectedValue(new Error('provider download response')),
    });

    await expect(adapter.read({ fileId: 'f' }, signal)).rejects.toEqual(new DriveClientDocumentError('download-failed'));
  });
});

describe('TelegramHttpDriveClientDocumentGateway', () => {
  it('requests exactly one byte beyond the accepted cap and returns the 206 remote total', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'private/file.json' } }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 206,
        headers: { 'content-range': 'bytes 0-65536/65537' },
      }));
    const gateway = new TelegramHttpDriveClientDocumentGateway('SECRET', request);

    const result = await gateway.download('f', MAX_DRIVE_CLIENT_DOCUMENT_BYTES, signal);

    expect(result.totalBytes).toBe(65_537);
    expect([...await collect(result.chunks)]).toEqual([...Buffer.from('{}')]);
    expect(request).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      headers: { range: 'bytes=0-65536' }, signal,
    }));
  });

  it('rejects malformed 206 range metadata', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'private/file.json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 206, headers: { 'content-range': 'bytes 1-2/3' } }));
    const gateway = new TelegramHttpDriveClientDocumentGateway('SECRET', request);

    await expect(gateway.download('f', MAX_DRIVE_CLIENT_DOCUMENT_BYTES, signal))
      .rejects.toEqual(new DriveClientDocumentError('download-failed'));
  });

  it('uses a whole-body content length when Telegram ignores the range', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'private/file.json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-length': '2' } }));
    const gateway = new TelegramHttpDriveClientDocumentGateway('SECRET', request);

    await expect(gateway.download('f', MAX_DRIVE_CLIENT_DOCUMENT_BYTES, signal)).resolves.toMatchObject({ totalBytes: 2 });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  for await (const value of source) values.push(value);
  return Buffer.concat(values);
}
