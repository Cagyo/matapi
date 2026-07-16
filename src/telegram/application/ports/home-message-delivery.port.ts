import type { Locale } from '../../domain/locale';
import type { HomeIdentity } from '../../domain/home-session';
import type { HomeScreen } from '../home-screen';

export const HOME_MESSAGE_DELIVERY = Symbol('HOME_MESSAGE_DELIVERY');

export interface HomeMessageDeliveryPort {
  send(input: {
    chatId: number;
    locale: Locale;
    identity: Omit<HomeIdentity, 'messageId'>;
    screen: HomeScreen;
    notice?: string;
  }): Promise<{ messageId: number }>;
  edit(input: {
    identity: HomeIdentity;
    locale: Locale;
    screen: HomeScreen;
  }): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  stripKeyboard(chatId: number, messageId: number): Promise<void>;
  closeMessage(chatId: number, messageId: number, locale: Locale): Promise<void>;
}
