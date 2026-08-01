import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import type {
  ArchiveUploadSourcePort,
  ArchiveUploadSourceStat,
} from '../../application/use-cases/upload-drive-object-attempt.use-case';

/** Bounded filesystem byte ranges for immutable archive sources. */
@Injectable()
export class FsArchiveUploadSourceAdapter implements ArchiveUploadSourcePort {
  async stat(path: string, signal: AbortSignal): Promise<ArchiveUploadSourceStat> {
    throwIfAborted(signal);
    const value = await stat(path, { bigint: true });
    throwIfAborted(signal);
    return { size: safeSize(value.size), mtimeNs: value.mtimeNs.toString() };
  }

  async *open(path: string, start: number, endExclusive: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive < start) {
      throw new Error('Archive source range is invalid');
    }
    if (start === endExclusive) return;
    const stream = createReadStream(path, {
      start,
      end: endExclusive - 1,
      highWaterMark: 64 * 1024,
      signal,
    });
    for await (const part of stream) yield part;
  }
}

function safeSize(value: bigint): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Archive source size exceeds the supported range');
  return size;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
