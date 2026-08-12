import { describe, expect, it } from 'vitest';
import { ApplicationLogUnavailableError } from '../../../src/system/domain/errors/application-log-unavailable.error';
import {
  REDACTED_APPLICATION_LOG_VALUE,
  sanitizeAndBoundApplicationLogLines,
} from '../../../src/system/infrastructure/application-log.mapper';

describe('sanitizeAndBoundApplicationLogLines', () => {
  it('strips ANSI while preserving stack ordering and source positions', () => {
    const result = sanitizeAndBoundApplicationLogLines([
      Buffer.from('\u001b[31mError: failed\u001b[0m'),
      Buffer.from('    at run (/srv/worker/src/main.ts:10:4)'),
    ], {}, 1024);

    expect(result).toEqual({
      lines: ['Error: failed', '    at run (/srv/worker/src/main.ts:10:4)'],
      truncatedByByteLimit: false,
    });
  });

  it.each([
    ['bot token', 'TELEGRAM_BOT_TOKEN', '123456789:abcdefghijklmnopqrstuvwxyzABCDE_123456789', 'token=123456789:abcdefghijklmnopqrstuvwxyzABCDE_123456789'],
    ['claim token', 'CLAIM_ADMIN_TOKEN', 'claim-token-1234', 'claim=claim-token-1234'],
    ['RTSP key', 'RTSP_CREDENTIALS_KEY', '0123456789abcdef', 'key=0123456789abcdef'],
  ])('redacts configured %s values', (_label, key, value, line) => {
    const result = sanitizeAndBoundApplicationLogLines(
      [Buffer.from(line)],
      { [key]: value },
      1024,
    );
    expect(result.lines[0]).toContain(REDACTED_APPLICATION_LOG_VALUE);
    expect(result.lines[0]).not.toContain(value);
  });

  it.each([
    ['Authorization: Bearer bearer-value-123'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA=='],
    ['rtsp://user:pass@camera.local/live'],
    ['https://example.test/path?access_token=secret-value&ok=1'],
  ])('redacts recognized credential form %s', (line) => {
    const result = sanitizeAndBoundApplicationLogLines([Buffer.from(line)], {}, 1024);
    expect(result.lines[0]).toContain(REDACTED_APPLICATION_LOG_VALUE);
    expect(result.lines[0]).not.toMatch(/bearer-value-123|dXNlcjpwYXNzd29yZA|user:pass|secret-value/);
  });

  it('fails closed for a configured secret shorter than eight UTF-8 bytes', () => {
    expect(() => sanitizeAndBoundApplicationLogLines(
      [Buffer.from('claim=short')],
      { CLAIM_ADMIN_TOKEN: 'short' },
      1024,
    )).toThrow(new ApplicationLogUnavailableError('sanitization-unsafe'));
  });

  it('does not treat secret metadata keys as secret values', () => {
    expect(sanitizeAndBoundApplicationLogLines(
      [Buffer.from('version=1')],
      { RTSP_CREDENTIALS_KEY_VERSION: '1' },
      1024,
    ).lines).toEqual(['version=1']);
  });

  it('replaces invalid UTF-8 and keeps only newest complete sanitized lines that fit', () => {
    const result = sanitizeAndBoundApplicationLogLines([
      Buffer.from('old'),
      Buffer.from([0x66, 0x6f, 0x80]),
      Buffer.from('newest'),
    ], {}, 13);
    expect(result).toEqual({
      lines: ['fo�', 'newest'],
      truncatedByByteLimit: true,
    });
  });

  it('rejects a newest sanitized line that cannot fit', () => {
    expect(() => sanitizeAndBoundApplicationLogLines(
      [Buffer.from('oversized')], {}, 4,
    )).toThrow(new ApplicationLogUnavailableError('snapshot-too-large'));
  });
});
