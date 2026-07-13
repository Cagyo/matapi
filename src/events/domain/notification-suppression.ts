import { SensorSeverity } from '../../sensors/domain/sensor';

/**
 * The four notification classes that flow through the delivery pipeline
 * (spec 19). `routine_motion` is `info`-severity motion; it is kept distinct
 * so the policy can name it explicitly in the suppression matrix.
 */
export type NotificationClass = SensorSeverity | 'routine_motion';

export interface NotificationSuppressionInput {
  notificationClass: NotificationClass;
  legacyMuted: boolean;
  timedPauseActive: boolean;
  targetPaused: boolean;
  inQuietHours: boolean;
}

/**
 * Pure suppression policy — the single source of truth for the per-recipient
 * fan-out matrix (spec 19):
 *
 * - `critical` bypasses every user preference. This is an invariant, not a
 *   configurable flag: a critical alarm is always eligible for delivery.
 * - `warning` bypasses quiet hours but respects legacy mute, timed pause, and
 *   per-target pause.
 * - `info` and `routine_motion` respect every applicable control, including
 *   quiet hours.
 *
 * The no-recipient broadcast fallback does not consult this policy.
 */
export function shouldSuppressNotification(
  input: NotificationSuppressionInput,
): boolean {
  if (input.notificationClass === 'critical') return false;
  if (input.legacyMuted || input.timedPauseActive || input.targetPaused) return true;
  return (
    (input.notificationClass === 'info' ||
      input.notificationClass === 'routine_motion') &&
    input.inQuietHours
  );
}

/**
 * A timed pause is active only while its deadline is strictly in the future.
 * At the exact deadline instant it is already inactive. `null` = no timed pause.
 */
export function isTimedPauseActive(
  pausedUntil: Date | null,
  now: Date,
): boolean {
  return pausedUntil !== null && pausedUntil.getTime() > now.getTime();
}
