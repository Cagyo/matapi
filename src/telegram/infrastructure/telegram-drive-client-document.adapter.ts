import { DriveClientDocumentError } from '../../archive/domain/errors/drive-client-document.error';

export const MAX_DRIVE_CLIENT_DOCUMENT_BYTES = 64 * 1024;
export const TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER = Symbol('TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER');

export interface TelegramDriveClientDocument {
  fileId: string;
  fileSize?: number;
}

export interface TelegramDriveClientDownload {
  chunks: AsyncIterable<Uint8Array>;
  totalBytes: number | null;
}

/** Minimal download seam so the stream cap is testable without leaking a Telegram URL. */
export interface TelegramDriveClientDocumentGateway {
  /** The gateway must enforce this bound at the HTTP transport (for example, with Range). */
  download(fileId: string, maxAcceptedBytes: number, signal: AbortSignal): Promise<TelegramDriveClientDownload>;
}

/** Reads a small OAuth client document entirely in memory and never logs its source URL. */
export class TelegramDriveClientDocumentAdapter {
  constructor(private readonly gateway: TelegramDriveClientDocumentGateway) {}

  async read(document: TelegramDriveClientDocument, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    if (!document.fileId) throw new DriveClientDocumentError('download-failed');
    if (document.fileSize !== undefined) {
      if (!Number.isSafeInteger(document.fileSize) || document.fileSize < 0) {
        throw new DriveClientDocumentError('download-failed');
      }
      if (document.fileSize > MAX_DRIVE_CLIENT_DOCUMENT_BYTES) {
        throw new DriveClientDocumentError('too-large');
      }
    }

    const download = await this.download(document.fileId, signal);
    if (download.totalBytes !== null && download.totalBytes > MAX_DRIVE_CLIENT_DOCUMENT_BYTES) {
      throw new DriveClientDocumentError('too-large');
    }

    const content = await this.readChunks(download.chunks, signal);
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new DriveClientDocumentError('invalid-utf8');
    }
  }

  private async download(fileId: string, signal: AbortSignal): Promise<TelegramDriveClientDownload> {
    try {
      return await this.gateway.download(fileId, MAX_DRIVE_CLIENT_DOCUMENT_BYTES, signal);
    } catch (error) {
      throw normalizeDownloadError(error, signal);
    }
  }

  private async readChunks(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of source) {
        throwIfAborted(signal);
        const bytes = Buffer.from(chunk);
        if (bytes.length > MAX_DRIVE_CLIENT_DOCUMENT_BYTES - size) {
          throw new DriveClientDocumentError('too-large');
        }
        parts.push(bytes);
        size += bytes.length;
      }
    } catch (error) {
      throw normalizeDownloadError(error, signal);
    }
    return Buffer.concat(parts);
  }
}

/** Telegram Bot API stream gateway. URLs and the bot token stay inside this adapter. */
export class TelegramHttpDriveClientDocumentGateway implements TelegramDriveClientDocumentGateway {
  constructor(
    private readonly token: string | undefined = process.env.TELEGRAM_BOT_TOKEN,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {}

  async download(fileId: string, maxAcceptedBytes: number, signal: AbortSignal): Promise<TelegramDriveClientDownload> {
    try {
      throwIfAborted(signal);
      if (!this.token || !fileId) throw new DriveClientDocumentError('download-failed');
      const metadata = await this.request(`https://api.telegram.org/bot${this.token}/getFile`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId }), signal,
      });
      const payload: unknown = await metadata.json();
      if (!metadata.ok || !isFilePayload(payload)) throw new DriveClientDocumentError('download-failed');
      const response = await this.request(`https://api.telegram.org/file/bot${this.token}/${payload.result.file_path}`, {
        headers: { range: `bytes=0-${maxAcceptedBytes}` }, signal,
      });
      if (!response.ok || !response.body) throw new DriveClientDocumentError('download-failed');
      const totalBytes = parseRemoteTotal(response.headers.get('content-range'))
        ?? parseWholeBodyLength(response.status, response.headers.get('content-length'));
      return { chunks: responseBodyChunks(response.body, signal), totalBytes };
    } catch (error) {
      throw normalizeDownloadError(error, signal);
    }
  }
}

async function* responseBodyChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    throw normalizeDownloadError(error, signal);
  } finally {
    reader.releaseLock();
  }
}

function parseRemoteTotal(value: string | null): number | null {
  if (value === null) return null;
  const match = /^bytes ([0-9]+)-[0-9]+\/([0-9]+)$/.exec(value);
  const total = match ? Number(match[2]) : Number.NaN;
  if (!match || match[1] !== '0' || !Number.isSafeInteger(total) || total < 0) {
    throw new DriveClientDocumentError('download-failed');
  }
  return total;
}

function parseWholeBodyLength(status: number, value: string | null): number | null {
  if (status !== 200 || value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new DriveClientDocumentError('download-failed');
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total < 0) throw new DriveClientDocumentError('download-failed');
  return total;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function normalizeDownloadError(error: unknown, signal: AbortSignal): DriveClientDocumentError | unknown {
  if (signal.aborted) throw signal.reason ?? error;
  if (error instanceof DriveClientDocumentError) return error;
  return new DriveClientDocumentError('download-failed');
}

function isFilePayload(value: unknown): value is { result: { file_path: string } } {
  return typeof value === 'object' && value !== null
    && 'result' in value && typeof value.result === 'object' && value.result !== null
    && 'file_path' in value.result && typeof value.result.file_path === 'string';
}
