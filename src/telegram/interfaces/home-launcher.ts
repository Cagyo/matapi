import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { OpenHomeUseCase } from '../application/open-home.use-case';
import { OPEN_NEW_HOME_CALLBACK } from '../domain/home-callback';
import type { HomeView } from '../domain/home-session';
import type { TelegramContext } from './telegram-context';

export interface HomeLaunchOptions {
  view?: HomeView;
  notice?: string;
}

@Injectable()
export class HomeLauncher {
  constructor(private readonly openHome: OpenHomeUseCase) {}

  async launch(
    ctx: TelegramContext,
    options: HomeLaunchOptions = {},
  ): Promise<'opened' | 'superseded' | 'unavailable' | 'ignored'> {
    const state = currentPrivateLocaleState(ctx);
    if (!state) return 'ignored';

    try {
      const result = await this.openHome.execute({
        userId: state.userId,
        chatId: state.chatId,
        locale: state.locale,
        role: state.role,
        view: options.view ?? { kind: 'home', checking: false },
        ...(options.notice === undefined ? {} : { notice: options.notice }),
      });
      if (result.kind === 'opened') return 'opened';
    } catch {
      await this.recoverUnavailable(ctx, state.catalog.home.recovery.unavailable);
      return 'unavailable';
    }

    await this.recoverStale(ctx, state.catalog.home.recovery.stale, state.catalog.home.recovery.openNewHome);
    return 'superseded';
  }

  private async recoverStale(ctx: TelegramContext, text: string, openNewHome: string): Promise<void> {
    try {
      await ctx.reply(text, {
        reply_markup: new InlineKeyboard().text(openNewHome, OPEN_NEW_HOME_CALLBACK),
      });
    } catch {
      // A recovery message is best-effort and must not mask the launch result.
    }
  }

  private async recoverUnavailable(ctx: TelegramContext, text: string): Promise<void> {
    try {
      await ctx.reply(text);
    } catch {
      // A recovery message is best-effort and must not mask the launch result.
    }
  }
}

function currentPrivateLocaleState(ctx: TelegramContext): {
  userId: number;
  chatId: number;
  locale: NonNullable<TelegramContext['localeState']>['locale'];
  role: NonNullable<TelegramContext['localeState']>['user']['role'];
  catalog: NonNullable<TelegramContext['localeState']>['catalog'];
} | null {
  const userId = ctx.from?.id;
  const chat = ctx.chat;
  const state = ctx.localeState;
  if (!userId || chat?.type !== 'private' || state?.user.telegramId !== userId) return null;

  return {
    userId,
    chatId: chat.id,
    locale: state.locale,
    role: state.user.role,
    catalog: state.catalog,
  };
}
