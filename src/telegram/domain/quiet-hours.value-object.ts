import { InvalidQuietHoursError } from './errors/invalid-quiet-hours.error';

export interface QuietHoursRange {
  /** Inclusive start, `HH:MM` 24h. */
  start: string;
  /** Exclusive end, `HH:MM` 24h. Overnight spans (start > end) are allowed. */
  end: string;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseQuietHoursRange(input: string): QuietHoursRange | null {
  const raw = input.trim();
  if (!raw) throw new InvalidQuietHoursError('format');
  if (raw.toLowerCase() === 'off') return null;

  const parts = raw.split('-');
  if (parts.length !== 2) throw new InvalidQuietHoursError('format');

  const start = parts[0].trim();
  const end = parts[1].trim();
  if (!HH_MM.test(start) || !HH_MM.test(end)) {
    throw new InvalidQuietHoursError('time');
  }
  if (start === end) throw new InvalidQuietHoursError('time');

  return { start, end };
}
