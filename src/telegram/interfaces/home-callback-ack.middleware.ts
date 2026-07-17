import type { MiddlewareFn } from 'grammy';
import { OPEN_NEW_HOME_CALLBACK } from '../domain/home-callback';
import { parseWorkflowReturnCallback } from '../domain/workflow-return';
import type { TelegramContext } from './telegram-context';

// One-release compatibility for callbacks emitted before receipt-bound `wr:`
// navigation. The middleware only acknowledges them; LegacyMenuHandler gives
// the locale-aware, non-mutating `/menu` direction.
export const LEGACY_WORKFLOW_RETURN_CALLBACK = /^rh:[lcsfidua]:[crt](?![\s\S])/;

export const homeCallbackAckMiddleware: MiddlewareFn<TelegramContext> = async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  if (data === OPEN_NEW_HOME_CALLBACK || data?.startsWith('h:')
    || LEGACY_WORKFLOW_RETURN_CALLBACK.test(data ?? '')
    || parseWorkflowReturnCallback(data ?? '') !== null) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    ctx.homeCallbackAcknowledged = true;
  }
  await next();
};
