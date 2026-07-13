import { describe, expect, it } from 'vitest';
import { criticalBypassDeprecationWarning } from '../../../src/events/infrastructure/env-critical-bypass';

describe('criticalBypassDeprecationWarning', () => {
  it.each(['false', 'true', ''])(
    'returns a deprecation warning when CRITICAL_IGNORES_QUIET_HOURS is set to %j',
    (value) => {
      const message = criticalBypassDeprecationWarning({
        CRITICAL_IGNORES_QUIET_HOURS: value,
      });
      expect(message).not.toBeNull();
      expect(message).toContain('CRITICAL_IGNORES_QUIET_HOURS');
      expect(message).toMatch(/no longer honored|no longer honoured/i);
      expect(message).toMatch(/critical/i);
      // The message must not echo the flag's value — only note that it is set.
      expect(message).toContain('set');
      if (value === 'false') {
        expect(message).not.toContain('false');
      }
      if (value === 'true') {
        // The word "true" must not leak the value; guard the whole message.
        expect(message?.includes('=true')).toBe(false);
        expect(message?.includes(': true')).toBe(false);
      }
    },
  );

  it('returns null when CRITICAL_IGNORES_QUIET_HOURS is unset', () => {
    expect(criticalBypassDeprecationWarning({})).toBeNull();
  });
});
