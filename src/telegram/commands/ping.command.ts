import { Injectable } from '@nestjs/common';
import { Bot } from 'grammy';
import { en } from '../../locales/en';
import { RoleGuard } from '../guards/role.guard';

@Injectable()
export class PingCommand {
  constructor(private readonly guard: RoleGuard) {}

  register(bot: Bot): void {
    bot.command('ping', this.guard.registered, async (ctx) => {
      await ctx.reply(en.ping.pong);
    });
  }
}
