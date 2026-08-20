import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import type {
  ArchiveUploadSourcePort,
  ArchiveUploadSourceStat,
} from '../../application/use-cases/upload-drive-object-attempt.use-case';
import {
  ArchiveSourceFilesystemError,
  type ArchiveSourceFilesystemErrorCode,
  type ArchiveSourceFilesystemOperation,
} from '../../domain/errors/archive-source-filesystem.error';

/** Bounded filesystem byte ranges for immutable archive sources. */
@Injectable()
export class FsArchiveUploadSourceAdapter implements ArchiveUploadSourcePort {
  async stat(path: string, signal: AbortSignal): Promise<ArchiveUploadSourceStat> {
    throwIfAborted(signal);
    let value: Awaited<ReturnType<typeof stat>>;
    try {
      value = await stat(path, { bigint: true });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortReason(signal, error);
      throw sourceFilesystemFailure('stat', error);
    }
    throwIfAborted(signal);
    return { size: safeSize(value.size), mtimeNs: value.mtimeNs.toString() };
  }

  async *open(path: string, start: number, endExclusive: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive < start) {
      throw new Error('Archive source range is invalid');
    }
    if (start === endExclusive) return;
    try {
      const stream = createReadStream(path, {
        start,
        end: endExclusive - 1,
        highWaterMark: 64 * 1024,
        signal,
      });
      for await (const part of stream) yield part;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortReason(signal, error);
      throw sourceFilesystemFailure('read', error);
    }
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

function sourceFilesystemFailure(
  operation: ArchiveSourceFilesystemOperation,
  error: unknown,
): ArchiveSourceFilesystemError {
  const code = nodeErrorCode(error);
  const safeCode: ArchiveSourceFilesystemErrorCode = code === 'ENOENT' || code === 'ENOTDIR'
    ? 'archive_source_missing'
    : code === 'EACCES' || code === 'EPERM'
      ? 'archive_source_access_denied'
      : code === 'EIO'
        ? 'archive_source_io_failure'
        : 'archive_source_unavailable';
  return new ArchiveSourceFilesystemError(safeCode, operation);
}

function nodeErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return fallback instanceof Error ? fallback : new DOMException('Aborted', 'AbortError');
}
