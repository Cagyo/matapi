import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { ApplicationLogUnavailableError } from '../domain/errors/application-log-unavailable.error';

export interface BoundedLogTailRequest {
  readonly path: string;
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface BoundedLogTailResult {
  readonly lines: readonly Buffer[];
  readonly truncatedByByteLimit: boolean;
}

type OpenFile = (path: string, flags: number) => Promise<FileHandle>;

interface CompleteLine {
  readonly bytes: Buffer;
  readonly start: number;
}

export class BoundedLogTailGateway {
  constructor(
    private readonly chunkBytes = 64 * 1024,
    private readonly openFile: OpenFile = open,
  ) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
      throw new RangeError('chunkBytes must be a positive safe integer');
    }
  }

  async read(input: BoundedLogTailRequest): Promise<BoundedLogTailResult> {
    const handle = await this.openSafe(input.path);
    try {
      return await this.readOpened(handle, input);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async openSafe(path: string): Promise<FileHandle> {
    let handle: FileHandle | undefined;

    try {
      handle = await this.openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new ApplicationLogUnavailableError('file-unavailable');
      }
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof ApplicationLogUnavailableError) throw error;
      throw new ApplicationLogUnavailableError('file-unavailable');
    }
  }

  private async readOpened(
    handle: FileHandle,
    input: BoundedLogTailRequest,
  ): Promise<BoundedLogTailResult> {
    try {
      return await this.readSnapshot(handle, input);
    } catch (error) {
      if (error instanceof ApplicationLogUnavailableError) throw error;
      throw new ApplicationLogUnavailableError('file-unavailable');
    }
  }

  private async readSnapshot(
    handle: FileHandle,
    input: BoundedLogTailRequest,
  ): Promise<BoundedLogTailResult> {
    const capturedSize = (await handle.stat()).size;
    if (capturedSize === 0 || input.maxLines === 0) {
      return { lines: [], truncatedByByteLimit: false };
    }

    const byteLimitStart = Math.max(0, capturedSize - input.maxBytes);
    let position = capturedSize;
    let retained = Buffer.alloc(0);

    while (position > 0) {
      const length = Math.min(this.chunkBytes, position);
      position -= length;
      const chunk = await this.readAt(handle, length, position);
      retained = Buffer.concat([chunk, retained]);

      const startsAfterLineFeed = position === 0
        || await this.byteBeforeIsLineFeed(handle, position);
      const completeLines = splitCompleteLines(retained, startsAfterLineFeed);
      const fittingLines = completeLines.filter(
        (line) => capturedSize - (position + line.start) <= input.maxBytes,
      );

      if (position === 0) {
        if (fittingLines.length === 0) {
          throw new ApplicationLogUnavailableError('snapshot-too-large');
        }
        return {
          lines: fittingLines.slice(-input.maxLines).map((line) => line.bytes),
          truncatedByByteLimit: completeLines.length > fittingLines.length,
        };
      }

      if (fittingLines.length >= input.maxLines) {
        return {
          lines: fittingLines.slice(-input.maxLines).map((line) => line.bytes),
          truncatedByByteLimit: false,
        };
      }

      if (position <= byteLimitStart) {
        if (fittingLines.length === 0) {
          throw new ApplicationLogUnavailableError('snapshot-too-large');
        }
        return {
          lines: fittingLines.map((line) => line.bytes),
          truncatedByByteLimit: true,
        };
      }
    }

    throw new ApplicationLogUnavailableError('snapshot-too-large');
  }

  private async byteBeforeIsLineFeed(handle: FileHandle, position: number): Promise<boolean> {
    const byteBefore = await this.readAt(handle, 1, position - 1);
    return byteBefore[0] === 0x0a;
  }

  private async readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, position);
    if (result.bytesRead !== length) {
      throw new ApplicationLogUnavailableError('snapshot-changed');
    }
    return result.buffer;
  }
}

function splitCompleteLines(buffer: Buffer, startsAfterLineFeed: boolean): CompleteLine[] {
  const lines: CompleteLine[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (startsAfterLineFeed || start > 0) {
      lines.push(toCompleteLine(buffer, start, index));
    }
    start = index + 1;
  }

  if (start < buffer.length && (startsAfterLineFeed || start > 0)) {
    lines.push(toCompleteLine(buffer, start, buffer.length));
  }

  return lines;
}

function toCompleteLine(buffer: Buffer, start: number, end: number): CompleteLine {
  const hasCarriageReturn = end > start && buffer[end - 1] === 0x0d;
  return {
    bytes: buffer.subarray(start, hasCarriageReturn ? end - 1 : end),
    start,
  };
}
