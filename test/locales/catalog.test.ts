import { describe, expect, it } from 'vitest';
import { catalogFor } from '../../src/locales/catalog';
import { en } from '../../src/locales/en';

describe('catalogFor', () => {
  it('returns English for English and invalid locale values', () => {
    expect(catalogFor('en')).toBe(en);
    expect(catalogFor('invalid')).toBe(en);
  });

  it('selects translated command and status formatters', () => {
    expect(catalogFor('ru').commands.find((c) => c.command === 'settings')?.description)
      .not.toBe(en.commands.find((c) => c.command === 'settings')?.description);
    expect(catalogFor('uk').status.footer(false, 2, new Date('2030-01-01T12:00:00Z')))
      .not.toContain('sensors offline');
  });
});
