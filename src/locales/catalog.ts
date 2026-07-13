import { normalizeLocale, type Locale } from '../telegram/domain/locale';
import { en } from './en';
import { ru } from './ru';
import { uk } from './uk';
import { deepFreeze, type DeepReadonly } from './freeze';

type EnglishCatalog = typeof en;

/** New locale sections may fall back to English until translations land. */
export type LocaleCatalog = Omit<EnglishCatalog, 'camera'> & {
  camera: Omit<EnglishCatalog['camera'], 'sources'> & {
    sources?: EnglishCatalog['camera']['sources'];
  };
};

export const catalogs: DeepReadonly<Record<Locale, LocaleCatalog>> = deepFreeze({
  en,
  ru,
  uk,
});

export function catalogFor(locale: unknown): LocaleCatalog {
  return catalogs[normalizeLocale(locale)];
}
