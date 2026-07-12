import { TimezoneOptions } from '../application/ports/timezone-options.port';

export function timezoneOptionsFromEnv(): TimezoneOptions {
  return { timezone: process.env.TIMEZONE || 'Europe/Kyiv' };
}
