import { describe, expect, it } from 'vitest';
import { catalogs, catalogFor } from '../../src/locales/catalog';
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

  it('deeply freezes catalogs and their registry', () => {
    expect(Object.isFrozen(catalogs)).toBe(true);
    expect(Object.isFrozen(en)).toBe(true);
    expect(Object.isFrozen(en.commands)).toBe(true);
    expect(Object.isFrozen(en.sensors.steps.contact)).toBe(true);
  });
});
