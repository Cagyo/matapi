import { Injectable } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class PingHandler implements TelegramHandler {
  constructor(private readonly guard: RoleMiddleware) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('ping', this.guard.registered, async (ctx) => {
      // `message.date` is Unix seconds at the Telegram server. Falling
      // back to handler entry keeps the round-trip non-zero in tests.
      const sentMs = ctx.message?.date ? ctx.message.date * 1000 : Date.now();
      const ms = Math.max(0, Date.now() - sentMs);
      await ctx.reply(en.ping.pong(ms));
    });
  }
}
