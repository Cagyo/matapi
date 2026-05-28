import { Injectable } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class HelpHandler implements TelegramHandler {
  constructor(private readonly guard: RoleMiddleware) {}

  register(composer: Composer<Context>): void {
    composer.command('help', this.guard.registered, async (ctx) => {
      const id = ctx.from?.id;
      const role = id ? await this.guard.resolveRole(id) : null;
      await ctx.reply(role === 'admin' ? en.help.admin : en.help.user);
    });
  }
}
