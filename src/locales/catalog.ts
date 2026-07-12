import { normalizeLocale, type Locale } from '../telegram/domain/locale';
import { en } from './en';
import { ru } from './ru';
import { uk } from './uk';
import { deepFreeze, type DeepReadonly } from './freeze';

export type LocaleCatalog = typeof en;

export const catalogs: DeepReadonly<Record<Locale, LocaleCatalog>> = deepFreeze({
  en,
  ru,
  uk,
});

export function catalogFor(locale: Locale | unknown): LocaleCatalog {
  return catalogs[normalizeLocale(locale)];
}
