import { Injectable } from '@nestjs/common';
import { Composer } from 'grammy';
import { currentWorkflowIdentity } from './workflow-entry.coordinator';
import { parseReturnHomeCallback } from './return-home';
import { RoleMiddleware } from './role.middleware';
import type { TelegramContext } from './telegram-context';
import type { TelegramHandler } from './telegram-handler';

const LEGACY_RETURN_CALLBACK = /^rh:[lcsfidua]:[crt](?![\s\S])/;

@Injectable()
export class ReturnHomeHandler implements TelegramHandler {
  constructor(private readonly guard: RoleMiddleware) {}

  register(composer: Composer<TelegramContext>): void {
    composer.callbackQuery(LEGACY_RETURN_CALLBACK, this.guard.registered, async (ctx) => {
      await acknowledgeOnce(ctx);
      if (!parseReturnHomeCallback(ctx.callbackQuery?.data ?? '')) return;
      const identity = currentWorkflowIdentity(ctx);
      if (!identity) return;
      const menu = identity.catalog.commands.find((command) => command.command === 'menu');
      if (menu) await ctx.reply(menu.usage);
    });
  }
}

async function acknowledgeOnce(ctx: TelegramContext): Promise<void> {
  if (ctx.homeCallbackAcknowledged) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.homeCallbackAcknowledged = true;
}
