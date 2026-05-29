import { formatInTimeZone } from 'date-fns-tz';

/**
 * Pure formatter for a motion-event notification caption (spec 19):
 *   `📹 Motion detected | front_door | 08.04.2026 12:51`
 * The timestamp is rendered in the configured timezone (DST-safe via
 * date-fns-tz). The caller injects `at`; no `new Date()` here.
 */
export function formatMotionCaption(
  cameraName: string,
  at: Date,
  timezone: string,
): string {
  const when = formatInTimeZone(at, timezone, 'dd.MM.yyyy HH:mm');
  return `📹 Motion detected | ${cameraName} | ${when}`;
}
