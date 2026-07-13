import { describe, expect, it } from 'vitest';
import {
  isTimedPauseActive,
  shouldSuppressNotification,
} from '../../../src/events/domain/notification-suppression';

describe('shouldSuppressNotification', () => {
  it.each([
    // All-clear → deliver for every class. These guard against an
    // "always suppress <class>" bug that quiet-only rows would not catch.
    { cls: 'critical', legacy: false, timed: false, target: false, quiet: false, suppressed: false },
    { cls: 'warning', legacy: false, timed: false, target: false, quiet: false, suppressed: false },
    { cls: 'info', legacy: false, timed: false, target: false, quiet: false, suppressed: false },
    { cls: 'routine_motion', legacy: false, timed: false, target: false, quiet: false, suppressed: false },
    // Critical bypasses everything, even fully stacked.
    { cls: 'critical', legacy: true, timed: true, target: true, quiet: true, suppressed: false },
    // Warning bypasses quiet hours but respects mute / timed / target.
    { cls: 'warning', legacy: false, timed: false, target: false, quiet: true, suppressed: false },
    { cls: 'warning', legacy: true, timed: false, target: false, quiet: false, suppressed: true },
    { cls: 'warning', legacy: false, timed: true, target: false, quiet: false, suppressed: true },
    { cls: 'warning', legacy: false, timed: false, target: true, quiet: false, suppressed: true },
    // Info and routine motion respect mute / timed / target, not just quiet hours.
    { cls: 'info', legacy: true, timed: false, target: false, quiet: false, suppressed: true },
    { cls: 'routine_motion', legacy: false, timed: true, target: false, quiet: false, suppressed: true },
    { cls: 'info', legacy: false, timed: false, target: false, quiet: true, suppressed: true },
    { cls: 'routine_motion', legacy: false, timed: false, target: false, quiet: true, suppressed: true },
  ] as const)(
    '$cls (legacy=$legacy timed=$timed target=$target quiet=$quiet) → suppressed=$suppressed',
    ({ cls, legacy, timed, target, quiet, suppressed }) => {
      expect(
        shouldSuppressNotification({
          notificationClass: cls,
          legacyMuted: legacy,
          timedPauseActive: timed,
          targetPaused: target,
          inQuietHours: quiet,
        }),
      ).toBe(suppressed);
    },
  );
});

describe('isTimedPauseActive', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');

  it('is false when no deadline is set', () => {
    expect(isTimedPauseActive(null, now)).toBe(false);
  });

  it('is true one millisecond before the deadline', () => {
    expect(isTimedPauseActive(new Date(now.getTime() + 1), now)).toBe(true);
  });

  it('is false at the exact deadline', () => {
    expect(isTimedPauseActive(now, now)).toBe(false);
  });

  it('is false one millisecond after the deadline', () => {
    expect(isTimedPauseActive(new Date(now.getTime() - 1), now)).toBe(false);
  });
});
