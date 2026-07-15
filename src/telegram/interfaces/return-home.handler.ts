import { Injectable } from '@nestjs/common';
import { Composer } from 'grammy';
import { HomeLauncher } from './home-launcher';
import { RoleMiddleware } from './role.middleware';
import { parseReturnHomeCallback } from './return-home';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class ReturnHomeHandler implements TelegramHandler {
  constructor(
    private readonly launcher: HomeLauncher,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.callbackQuery(/^rh:[lcs]:[crt]$/, this.guard.registered, async (ctx) => {
      if (!ctx.homeCallbackAcknowledged) {
        await ctx.answerCallbackQuery().catch(() => undefined);
      }
      if (!parseReturnHomeCallback(ctx.callbackQuery?.data ?? '')) return;
      await this.launcher.launch(ctx);
    });
  }
}
