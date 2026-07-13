import type { MiddlewareFn } from 'grammy';
import { OPEN_NEW_HOME_CALLBACK } from '../domain/home-callback';
import type { TelegramContext } from './telegram-context';

export const homeCallbackAckMiddleware: MiddlewareFn<TelegramContext> = async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  if (data === OPEN_NEW_HOME_CALLBACK || data?.startsWith('h:')) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    ctx.homeCallbackAcknowledged = true;
  }
  await next();
};
