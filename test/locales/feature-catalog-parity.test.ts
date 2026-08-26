import { describe, expect, it } from 'vitest';
import { catalogs } from '../../src/locales/catalog';
import { FEATURE_INSTALL_FAILURE_CODES, type FeatureAction } from '../../src/features/domain/manageable-feature';

const FEATURE_ACTIONS: readonly FeatureAction[] = ['install', 'reinstall', 'enable', 'disable', 'verify'];

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

  it('names every offerable action in every locale', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const confirmation = catalog.feature.confirmation as Record<string, unknown>;
      expect(Object.keys(confirmation).sort(), locale).toEqual([...FEATURE_ACTIONS].sort());
      expect(catalog.feature.reinstallAction.length, locale).toBeGreaterThan(0);
      expect(catalog.feature.reinstallNotice.length, locale).toBeGreaterThan(0);
      expect(catalog.feature.progress.reinstalling('X'), locale).toContain('X');
      expect(catalog.feature.errors.reinstallUnavailable('X'), locale).toContain('X');
    }
  });

  it('labels every install failure cause in every locale without raw diagnostics', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const labels = catalog.feature.failure as Record<string, string>;
      expect(Object.keys(labels).sort()).toEqual([...FEATURE_INSTALL_FAILURE_CODES].sort());
      for (const code of FEATURE_INSTALL_FAILURE_CODES) {
        const label = labels[code];
        expect(typeof label, `${locale}/${code}`).toBe('string');
        expect(label.length, `${locale}/${code}`).toBeGreaterThan(0);
        // Operator copy names the cause only: no path, no exit status, no
        // command output smuggled into a localized string.
        expect(label, `${locale}/${code}`).not.toMatch(/[\n/\\]|\d/);
      }
    }
  });
});
