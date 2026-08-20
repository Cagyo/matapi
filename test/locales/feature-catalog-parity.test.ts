import { describe, expect, it } from 'vitest';
import { catalogs } from '../../src/locales/catalog';

function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]));
  }
  return typeof value;
}

describe('feature locale catalog parity', () => {
  it('keeps all localized feature workflow sections structurally identical', () => {
    expect(shape(catalogs.ru.feature)).toEqual(shape(catalogs.en.feature));
    expect(shape(catalogs.uk.feature)).toEqual(shape(catalogs.en.feature));
  });
});
