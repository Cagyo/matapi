import { describe, expect, it } from 'vitest';
import { InvalidQuietHoursError } from '../../../src/telegram/domain/errors/invalid-quiet-hours.error';
import { parseQuietHoursRange } from '../../../src/telegram/domain/quiet-hours.value-object';

describe('parseQuietHoursRange', () => {
  it('parses a same-day range', () => {
    expect(parseQuietHoursRange('09:00-17:00')).toEqual({
      start: '09:00',
      end: '17:00',
    });
  });

  it('parses an overnight range', () => {
    expect(parseQuietHoursRange('23:00-07:00')).toEqual({
      start: '23:00',
      end: '07:00',
    });
  });

  it('accepts surrounding whitespace', () => {
    expect(parseQuietHoursRange('  08:30 - 22:45  ')).toEqual({
      start: '08:30',
      end: '22:45',
    });
  });

  it('returns null for the "off" keyword (case-insensitive)', () => {
    expect(parseQuietHoursRange('off')).toBeNull();
    expect(parseQuietHoursRange('OFF')).toBeNull();
  });

  it('throws a format error on a missing dash', () => {
    expect(() => parseQuietHoursRange('09:00 17:00')).toThrow(
      InvalidQuietHoursError,
    );
  });

  it('throws a time error on out-of-range hours', () => {
    expect(() => parseQuietHoursRange('25:00-07:00')).toThrow(
      InvalidQuietHoursError,
    );
  });

  it('throws a time error when start equals end', () => {
    expect(() => parseQuietHoursRange('09:00-09:00')).toThrow(
      InvalidQuietHoursError,
    );
  });

  it('exposes the reason on the thrown error', () => {
    try {
      parseQuietHoursRange('99:99-07:00');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidQuietHoursError);
      expect((err as InvalidQuietHoursError).reason).toBe('time');
    }
  });
});
