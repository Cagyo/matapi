import { afterEach, describe, expect, it, vi } from 'vitest';
import { timezoneOptionsFromEnv } from '../../../src/config/infrastructure/env-timezone-options.adapter';

describe('timezoneOptionsFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to Europe/Kyiv', () => {
    vi.stubEnv('TIMEZONE', '');
    expect(timezoneOptionsFromEnv()).toEqual({ timezone: 'Europe/Kyiv' });
  });

  it('keeps an explicit IANA timezone', () => {
    vi.stubEnv('TIMEZONE', 'America/New_York');
    expect(timezoneOptionsFromEnv()).toEqual({ timezone: 'America/New_York' });
  });
});
