import { toZonedTime } from 'date-fns-tz';

/** A user's quiet-hours window. `null` on either bound means disabled. */
export interface QuietHoursWindow {
  quietStart: string | null;
  quietEnd: string | null;
}

/**
 * Returns `true` when `now` falls inside the user's quiet-hours window,
 * evaluated in `timezone` (spec 12, 19). Pure: the caller injects `now`
 * via `ClockPort` — never `new Date()` here. Overnight windows
 * (`23:00`–`07:00`) are handled as "start > end means crosses midnight".
 * DST transitions are handled by the timezone library.
 */
export function isInQuietHours(
  user: QuietHoursWindow,
  now: Date,
  timezone: string,
): boolean {
  if (!user.quietStart || !user.quietEnd) return false;

  const start = parseHHmm(user.quietStart);
  const end = parseHHmm(user.quietEnd);
  if (start === null || end === null) return false;

  const local = toZonedTime(now, timezone);
  const localMinutes = local.getHours() * 60 + local.getMinutes();

  return start > end
    ? localMinutes >= start || localMinutes < end // overnight 23:00–07:00
    : localMinutes >= start && localMinutes < end; // same day 09:00–17:00
}

/** Parses `HH:MM` (24-hour) into minutes-of-day, or `null` when invalid. */
function parseHHmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
