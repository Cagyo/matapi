import { DriveConfigurationError } from '../../archive/domain/errors/drive-configuration.error';

export const MAX_DRIVE_CLIENT_DOCUMENT_BYTES = 64 * 1024;
export const TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER = Symbol('TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER');

export interface TelegramDriveClientDocument {
  fileId: string;
  fileSize?: number;
}

/** Minimal download seam so the stream cap is testable without leaking a Telegram URL. */
export interface TelegramDriveClientDocumentGateway {
  /** The gateway must enforce this bound at the HTTP transport (for example, with Range). */
  download(fileId: string, maxBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Reads a small OAuth client document entirely in memory and never logs its source URL. */
export class TelegramDriveClientDocumentAdapter {
  constructor(private readonly gateway: TelegramDriveClientDocumentGateway) {}

  async read(document: TelegramDriveClientDocument, signal: AbortSignal): Promise<string> {
    if (!document.fileId || (document.fileSize !== undefined && (!Number.isSafeInteger(document.fileSize) || document.fileSize < 0 || document.fileSize > MAX_DRIVE_CLIENT_DOCUMENT_BYTES))) {
      throw new DriveConfigurationError('Drive client document is too large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.gateway.download(document.fileId, MAX_DRIVE_CLIENT_DOCUMENT_BYTES, signal)) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const bytes = Buffer.from(chunk);
      if (bytes.length > MAX_DRIVE_CLIENT_DOCUMENT_BYTES - size) {
        throw new DriveConfigurationError('Drive client document is too large');
      }
      chunks.push(bytes);
      size += bytes.length;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.includes('\uFFFD')) throw new DriveConfigurationError('Drive client document must be UTF-8');
    return text;
  }
}
