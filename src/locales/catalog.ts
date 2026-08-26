import { normalizeLocale, type Locale } from '../telegram/domain/locale';
import { en } from './en';
import { ru } from './ru';
import { uk } from './uk';
import { deepFreeze, type DeepReadonly } from './freeze';

/**
 * Every locale carries the whole English shape — nothing is optional.
 *
 * `camera.sources` used to be, so a locale without translations could fall back
 * to English while they landed. It no longer may: that workflow asks an
 * administrator to paste an address carrying a camera password, and an
 * administrator who cannot read the warning cannot consent to it. Making the
 * section required is what turns a missing translation into a build failure.
 */
export type LocaleCatalog = typeof en;

export const catalogs: DeepReadonly<Record<Locale, LocaleCatalog>> = deepFreeze({
  en,
  ru,
  uk,
});

export function catalogFor(locale: unknown): LocaleCatalog {
  return catalogs[normalizeLocale(locale)];
}
