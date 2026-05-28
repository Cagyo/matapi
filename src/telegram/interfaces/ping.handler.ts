import { Injectable } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class PingHandler implements TelegramHandler {
  constructor(private readonly guard: RoleMiddleware) {}

  register(composer: Composer<Context>): void {
    composer.command('ping', this.guard.registered, async (ctx) => {
      const started = Date.now();
      await ctx.reply(en.ping.pong(Date.now() - started));
    });
  }
}
