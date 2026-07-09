import { describe, expect, it } from 'vitest';
import {
  buildBrowseRange,
  formatBrowseDateLabel,
  parseBrowseDateInput,
  parseTimeRangeInput,
} from '../../../src/telegram/interfaces/camera.handler';

describe('camera browse input parsers', () => {
  it('parses DD.MM.YYYY dates and rejects impossible dates', () => {
    expect(parseBrowseDateInput('08.04.2026')).toEqual({
      ok: true,
      date: new Date(2026, 3, 8),
      dateLabel: '08.04.2026',
    });
    expect(parseBrowseDateInput('31.02.2026')).toEqual({ ok: false });
    expect(parseBrowseDateInput('2026-04-08')).toEqual({ ok: false });
  });

  it('parses canonical time ranges and whitespace around the hyphen', () => {
    expect(parseTimeRangeInput('18:00-23:00')).toEqual({
      ok: true,
      startHour: 18,
      startMinute: 0,
      endHour: 23,
      endMinute: 0,
      label: '18:00-23:00',
    });
    expect(parseTimeRangeInput('18:00 - 23:00')).toEqual({
      ok: true,
      startHour: 18,
      startMinute: 0,
      endHour: 23,
      endMinute: 0,
      label: '18:00-23:00',
    });
  });

  it('rejects malformed, shorthand, impossible, zero-length, and overnight ranges', () => {
    expect(parseTimeRangeInput('8-9')).toEqual({ ok: false, reason: 'format' });
    expect(parseTimeRangeInput('24:00-25:00')).toEqual({ ok: false, reason: 'format' });
    expect(parseTimeRangeInput('18:60-19:00')).toEqual({ ok: false, reason: 'format' });
    expect(parseTimeRangeInput('18:00-18:00')).toEqual({ ok: false, reason: 'order' });
    expect(parseTimeRangeInput('23:00-01:00')).toEqual({ ok: false, reason: 'order' });
  });

  it('builds local Date boundaries with inclusive start and exclusive end semantics', () => {
    const parsed = parseTimeRangeInput('18:00-23:00');
    if (!parsed.ok) throw new Error('expected valid range');

    expect(formatBrowseDateLabel(new Date(2026, 3, 8))).toBe('08.04.2026');
    expect(buildBrowseRange(new Date(2026, 3, 8), parsed)).toEqual({
      start: new Date(2026, 3, 8, 18, 0),
      end: new Date(2026, 3, 8, 23, 0),
      rangeLabel: '18:00-23:00',
    });
  });
});
