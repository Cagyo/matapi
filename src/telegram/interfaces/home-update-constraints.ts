import type { TelegramContext } from './telegram-context';

export function homeUpdateConstraints(ctx: TelegramContext): string[] {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (ctx.chat?.type !== 'private' || chatId === undefined || userId === undefined) {
    return [];
  }
  return [`home:chat:${chatId}`, `home:user:${userId}`];
}
