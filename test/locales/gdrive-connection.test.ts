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

it('keeps every Drive drain, action, and retry outcome localized in every catalog', () => {
  const drainStates = [
    'active', 'idle', 'cooling-down', 'branch-blocked', 'quota-blocked',
    'capacity-blocked', 'policy-blocked', 'clock-blocked', 'reauthorization-required',
  ];
  const actions = [
    'restore-date-folder', 'free-drive-space', 'fix-capacity-then-retry',
    'fix-policy-then-retry', 'fix-system-clock', 'reauthorize',
  ];
  const outcomes = ['scheduled', 'stale', 'automatic-quota-probe', 'reauthorize', 'nothing-blocked'];

  for (const catalog of Object.values(catalogs)) {
    expect(Object.keys(catalog.gdrive.drainStates).sort()).toEqual([...drainStates].sort());
    expect(Object.keys(catalog.gdrive.actions).sort()).toEqual([...actions].sort());
    expect(Object.keys(catalog.gdrive.retryResults).sort()).toEqual([...outcomes].sort());
    expect(catalog.gdrive.retryButton).toEqual(expect.any(String));
    expect(catalog.gdrive.usage).toContain('connect|status|retry|disconnect');
  }
});
