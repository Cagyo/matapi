import { Injectable } from '@nestjs/common';
import { Bot } from 'grammy';
import { en } from '../../locales/en';
import { RoleGuard } from '../guards/role.guard';

@Injectable()
export class HelpCommand {
  constructor(private readonly guard: RoleGuard) {}

  register(bot: Bot): void {
    bot.command('help', this.guard.registered, async (ctx) => {
      await ctx.reply(en.help.body);
    });
  }
}
