import { Context } from 'grammy';
import { LocaleCatalog } from '../../locales';
import { Locale } from '../domain/locale';
import { User } from '../domain/user.entity';

export interface LocaleState {
  user: User;
  locale: Locale;
  catalog: LocaleCatalog;
}

export type TelegramContext = Context & {
  localeState?: LocaleState;
  homeCallbackAcknowledged?: boolean;
};
