import { Composer } from 'grammy';
import { TelegramContext } from './telegram-context';

/**
 * Convention for every telegram interface handler: self-registers its
 * commands/middleware onto a grammY `Composer` (a `Bot` or a filtered
 * sub-composer). The `GrammyBotGateway` iterates injected handlers and
 * calls `register`.
 */
export interface TelegramHandler {
  register(composer: Composer<TelegramContext>): void;
}
