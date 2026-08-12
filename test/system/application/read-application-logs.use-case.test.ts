import { describe, expect, it } from 'vitest';
import { ReadApplicationLogsUseCase } from '../../../src/system/application/read-application-logs.use-case';
import {
  APPLICATION_LOG_MAX_BYTES,
  APPLICATION_LOG_MAX_LINES,
} from '../../../src/system/domain/application-log';
import { ApplicationLogUnavailableError } from '../../../src/system/domain/errors/application-log-unavailable.error';
import { InMemoryApplicationLogReaderAdapter } from '../../../src/system/infrastructure/in-memory-application-log-reader.adapter';

describe('ReadApplicationLogsUseCase', () => {
  it.each(['output', 'error'] as const)('requests the fixed safe limits for %s', async (stream) => {
    const reader = new InMemoryApplicationLogReaderAdapter({
      [stream]: { stream, lines: ['one'], truncatedByByteLimit: false },
    });
    const useCase = new ReadApplicationLogsUseCase(reader);

    await expect(useCase.execute(stream)).resolves.toEqual({
      stream,
      lines: ['one'],
      truncatedByByteLimit: false,
    });
    expect(reader.requests).toEqual([
      {
        stream,
        limits: { maxLines: APPLICATION_LOG_MAX_LINES, maxBytes: APPLICATION_LOG_MAX_BYTES },
      },
    ]);
  });

  it('preserves an empty byte-truncated snapshot', async () => {
    const reader = new InMemoryApplicationLogReaderAdapter({
      error: { stream: 'error', lines: [], truncatedByByteLimit: true },
    });

    await expect(new ReadApplicationLogsUseCase(reader).execute('error')).resolves.toEqual({
      stream: 'error',
      lines: [],
      truncatedByByteLimit: true,
    });
  });

  it('propagates a safe typed reader failure', async () => {
    const failure = new ApplicationLogUnavailableError('pm2-unavailable');
    const reader = new InMemoryApplicationLogReaderAdapter({}, failure);

    await expect(new ReadApplicationLogsUseCase(reader).execute('output')).rejects.toBe(failure);
  });
});
