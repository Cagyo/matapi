import { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import { catalogFor } from '../../../src/locales';
import {
  appendReturnHomeButton,
  isReturnHomeCallback,
  parseReturnHomeCallback,
  returnHomeCallback,
  returnHomeKeyboard,
} from '../../../src/telegram/interfaces/return-home';

describe('return-home callback contract', () => {
  it.each([
    ['logs', 'l'],
    ['csv', 'c'],
    ['settings', 's'],
    ['config', 'f'],
    ['configImport', 'i'],
    ['drive', 'd'],
    ['systemUpdate', 'u'],
  ] as const)('round-trips %s as code %s', (workflow, code) => {
    const data = returnHomeCallback({ workflow, phase: 'cancelPending' });

    expect(data).toBe(`rh:${code}:c`);
    expect(Buffer.byteLength(data, 'utf8')).toBe(6);
    expect(parseReturnHomeCallback(data)).toEqual({
      workflow,
      phase: 'cancelPending',
    });
  });

  it.each([
    'rh:l',
    'rh:l:x',
    'rh:logs:t',
    'rh:f',
    'rh:i:x',
    'rh:drive:t',
    'rh:u:t:extra',
    'rh:x:t',
    'h:token:0:h',
  ])(
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

  it('appends Home on a final row without replacing workflow actions', () => {
    const keyboard = new InlineKeyboard()
      .text('Apply', 'imp:apply')
      .text('Cancel', 'imp:cancel');

    appendReturnHomeButton(keyboard, catalogFor('uk'), {
      workflow: 'configImport',
      phase: 'cancelPending',
    });

    expect(JSON.stringify(keyboard)).toContain('imp:apply');
    expect(JSON.stringify(keyboard)).toContain('imp:cancel');
    expect(JSON.stringify(keyboard)).toContain('🏠 Дім');
    expect(JSON.stringify(keyboard)).toContain('rh:i:c');
    expect(keyboard.inline_keyboard.at(-1)).toHaveLength(1);
  });
});
