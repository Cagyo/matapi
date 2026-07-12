import { normalizeLocale, type Locale } from '../telegram/domain/locale';
import { en } from './en';
import { ru } from './ru';
import { uk } from './uk';

export type LocaleCatalog = typeof en;

export const catalogs: Readonly<Record<Locale, LocaleCatalog>> = {
  en,
  ru,
  uk,
};

export function catalogFor(locale: Locale | unknown): LocaleCatalog {
  return catalogs[normalizeLocale(locale)];
}
