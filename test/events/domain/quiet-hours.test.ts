import { describe, expect, it } from 'vitest';
import { isInQuietHours } from '../../../src/events/domain/quiet-hours';

const TZ = 'Europe/Kyiv';

describe('isInQuietHours', () => {
  it('returns false when no window is configured', () => {
    expect(isInQuietHours({ quietStart: null, quietEnd: null }, new Date(), TZ)).toBe(
      false,
    );
    expect(
      isInQuietHours({ quietStart: '23:00', quietEnd: null }, new Date(), TZ),
    ).toBe(false);
  });

  it('handles a same-day window (09:00–17:00)', () => {
    const window = { quietStart: '09:00', quietEnd: '17:00' };
    // 12:00 Kyiv (UTC+3 in summer) → 09:00 UTC.
    expect(isInQuietHours(window, new Date('2026-07-01T09:00:00Z'), TZ)).toBe(true);
    // 20:00 Kyiv → 17:00 UTC.
    expect(isInQuietHours(window, new Date('2026-07-01T17:00:00Z'), TZ)).toBe(false);
  });

  it('handles an overnight window (23:00–07:00)', () => {
    const window = { quietStart: '23:00', quietEnd: '07:00' };
    // 02:00 Kyiv summer → 23:00 UTC previous day.
    expect(isInQuietHours(window, new Date('2026-06-30T23:00:00Z'), TZ)).toBe(true);
    // 10:00 Kyiv → 07:00 UTC.
    expect(isInQuietHours(window, new Date('2026-07-01T07:00:00Z'), TZ)).toBe(false);
  });

  it('is exclusive of the end boundary and inclusive of the start', () => {
    const window = { quietStart: '09:00', quietEnd: '17:00' };
    // exactly 09:00 Kyiv (06:00 UTC summer) → inside.
    expect(isInQuietHours(window, new Date('2026-07-01T06:00:00Z'), TZ)).toBe(true);
    // exactly 17:00 Kyiv (14:00 UTC summer) → outside.
    expect(isInQuietHours(window, new Date('2026-07-01T14:00:00Z'), TZ)).toBe(false);
  });

  it('returns false for malformed time strings', () => {
    expect(
      isInQuietHours({ quietStart: '25:00', quietEnd: '07:00' }, new Date(), TZ),
    ).toBe(false);
    expect(
      isInQuietHours({ quietStart: 'nope', quietEnd: '07:00' }, new Date(), TZ),
    ).toBe(false);
  });
});
