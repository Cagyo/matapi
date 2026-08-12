import { expect, it } from 'vitest';
import { catalogs } from '../../src/locales';

function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key, shape((value as Record<string, unknown>)[key]),
    ]));
  }
  return typeof value;
}

it('keeps the Drive setup catalog shape identical and each guide within 3,500 characters', () => {
  expect(shape(catalogs.uk.gdriveConnection)).toEqual(shape(catalogs.en.gdriveConnection));
  expect(shape(catalogs.ru.gdriveConnection)).toEqual(shape(catalogs.en.gdriveConnection));
  for (const catalog of Object.values(catalogs)) {
    expect(catalog.gdriveConnection.guide.length).toBeLessThanOrEqual(3_500);
    expect(catalog.gdriveConnection.guide).toContain('TVs and Limited Input devices');
    expect(catalog.gdriveConnection.guide).toContain('https://www.googleapis.com/auth/drive.file');
    expect(catalog.gdriveConnection.guide).toMatch(/seven days|сім днів|семь дней/u);
  }
});
