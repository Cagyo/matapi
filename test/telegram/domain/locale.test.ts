import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  isLocale,
  normalizeLocale,
} from '../../../src/telegram/domain/locale';

describe('locale', () => {
  it('recognizes supported locales only', () => {
    expect(isLocale('uk')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });

  it('normalizes absent and corrupt values to the default locale', () => {
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('corrupt')).toBe(DEFAULT_LOCALE);
  });
});
