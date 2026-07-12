import { Injectable } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext } from './telegram-context';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class HelpHandler implements TelegramHandler {
  constructor(private readonly guard: RoleMiddleware) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('help', this.guard.registered, async (ctx) => {
      const role = ctx.localeState?.user.role;
      await ctx.reply(role === 'admin' ? en.help.admin : en.help.user);
    });
  }
}
