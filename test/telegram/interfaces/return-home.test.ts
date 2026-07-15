import { describe, expect, it } from 'vitest';
import { catalogFor } from '../../../src/locales';
import {
  isReturnHomeCallback,
  parseReturnHomeCallback,
  returnHomeCallback,
  returnHomeKeyboard,
} from '../../../src/telegram/interfaces/return-home';

describe('return-home callback contract', () => {
  it('round-trips the fixed CSV leave-running action', () => {
    const data = returnHomeCallback({ workflow: 'csv', phase: 'leaveRunning' });

    expect(data).toBe('rh:c:r');
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(parseReturnHomeCallback(data)).toEqual({
      workflow: 'csv',
      phase: 'leaveRunning',
    });
  });

  it.each(['rh:l', 'rh:l:x', 'rh:logs:t', 'rh:x:t', 'h:token:0:h'])(
    'rejects non-contract payload %s',
    (data) => expect(parseReturnHomeCallback(data)).toBeNull(),
  );

  it('recognizes only valid return-home callback payloads', () => {
    expect(isReturnHomeCallback('rh:l:c')).toBe(true);
    expect(isReturnHomeCallback('rh:l:x')).toBe(false);
    expect(isReturnHomeCallback(undefined)).toBe(false);
  });

  it('uses the selected catalog label without putting it in callback data', () => {
    const keyboard = returnHomeKeyboard(catalogFor('uk'), {
      workflow: 'settings',
      phase: 'cancelPending',
    });

    expect(JSON.stringify(keyboard)).toContain('🏠 Дім');
    expect(JSON.stringify(keyboard)).toContain('rh:s:c');
  });
});
