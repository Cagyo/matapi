import { Injectable } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { CloseHomeUseCase } from '../application/close-home.use-case';
import { OpenHomeUseCase } from '../application/open-home.use-case';
import { RefreshHomeMonitoringUseCase } from '../application/refresh-home-monitoring.use-case';
import { RenderHomeUseCase, type RenderHomeResult } from '../application/render-home.use-case';
import { ValidateHomeCallbackUseCase } from '../application/validate-home-callback.use-case';
import type { HomeView } from '../domain/home-session';
import { OPEN_NEW_HOME_CALLBACK, parseHomeCallback } from '../domain/home-callback';
import { CameraHandler } from './camera.handler';
import { LegacyMenuHandler } from './legacy-menu.handler';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext, type LocaleState } from './telegram-context';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class HomeHandler implements TelegramHandler {
  constructor(
    private readonly guard: RoleMiddleware,
    private readonly openHome: OpenHomeUseCase,
    private readonly validateCallback: ValidateHomeCallbackUseCase,
    private readonly renderHome: RenderHomeUseCase,
    private readonly refreshMonitoring: RefreshHomeMonitoringUseCase,
    private readonly closeHome: CloseHomeUseCase,
    private readonly camera: CameraHandler,
    private readonly legacyMenu: LegacyMenuHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('menu', this.guard.registered, async (ctx) => {
      await this.open(ctx);
    });
    composer.callbackQuery(/^(?:h:|ho$)/, this.guard.registered, async (ctx) => {
      await this.handleCallback(ctx);
    });
  }

  private async open(ctx: TelegramContext): Promise<void> {
    const current = this.current(ctx);
    if (!current) return;
    try {
      const result = await this.openHome.execute({
        userId: current.userId,
        chatId: current.chatId,
        locale: current.state.locale,
        role: current.state.user.role,
        view: { kind: 'home', checking: false },
      });
      if (result.kind === 'superseded') await this.recover(ctx, 'stale');
    } catch {
      await this.recover(ctx, 'unavailable');
    }
  }

  private async handleCallback(ctx: TelegramContext): Promise<void> {
    const current = this.current(ctx);
    if (!current) return;
    const data = ctx.callbackQuery?.data;
    if (data === OPEN_NEW_HOME_CALLBACK) {
      await this.open(ctx);
      return;
    }

    const parsed = data ? parseHomeCallback(data) : null;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!parsed || !messageId) {
      await this.recover(ctx, 'stale');
      return;
    }

    let verdict: Awaited<ReturnType<ValidateHomeCallbackUseCase['execute']>>;
    try {
      verdict = await this.validateCallback.execute({
        parsed,
        userId: current.userId,
        chatId: current.chatId,
        messageId,
      });
    } catch {
      await this.recover(ctx, 'unavailable');
      return;
    }
    if (verdict.kind === 'updating') {
      await this.recover(ctx, 'updating');
      return;
    }
    if (verdict.kind !== 'accepted') {
      await this.recover(ctx, 'stale');
      return;
    }

    try {
      switch (parsed.action.kind) {
        case 'home':
          await this.render(ctx, verdict.active, { kind: 'home', checking: false });
          return;
        case 'sensors':
          await this.render(ctx, verdict.active, {
            kind: 'sensors', page: parsed.action.page, checking: false,
          });
          return;
        case 'camera':
          await this.camera.handleDashboard(ctx);
          return;
        case 'notifications':
          await this.legacyMenu.openNotifications(ctx);
          return;
        case 'more':
          await this.legacyMenu.openDashboard(ctx);
          return;
        case 'check':
          await this.check(ctx, verdict.active, verdict.view);
          return;
        case 'close': {
          const closed = await this.closeHome.execute({
            identity: verdict.active,
            locale: current.state.locale,
          });
          if (closed === 'stale') await this.recover(ctx, 'stale');
          return;
        }
      }
    } catch {
      await this.recover(ctx, 'unavailable');
    }
  }

  private async check(
    ctx: TelegramContext,
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    acceptedView: HomeView,
  ): Promise<void> {
    const checking = await this.renderHome.execute({
      active,
      ...this.renderOptions(ctx),
      view: { ...acceptedView, checking: true },
    });
    if (!this.isRendered(checking)) {
      await this.recoverRenderFailure(ctx, checking);
      return;
    }

    try {
      await this.refreshMonitoring.execute();
    } catch {
      // Keep the Home interaction coherent even if an infrastructure adapter
      // violates the refresh use case's normal failure-as-result contract.
    }

    const complete = await this.renderHome.execute({
      active: checking.active,
      ...this.renderOptions(ctx),
      view: { ...checking.view, checking: false },
    });
    if (!this.isRendered(complete)) await this.recoverRenderFailure(ctx, complete);
  }

  private async render(
    ctx: TelegramContext,
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    view: HomeView,
  ): Promise<void> {
    const result = await this.renderHome.execute({ active, ...this.renderOptions(ctx), view });
    if (!this.isRendered(result)) await this.recoverRenderFailure(ctx, result);
  }

  private renderOptions(ctx: TelegramContext): Pick<Parameters<RenderHomeUseCase['execute']>[0], 'locale' | 'role'> {
    const state = ctx.localeState!;
    return { locale: state.locale, role: state.user.role };
  }

  private isRendered(result: RenderHomeResult): result is Extract<RenderHomeResult, { active: unknown }> {
    return result.kind === 'rendered' || result.kind === 'reopened';
  }

  private async recoverRenderFailure(ctx: TelegramContext, result: RenderHomeResult): Promise<void> {
    await this.recover(ctx, result.kind === 'delivery_failed' ? 'unavailable' : 'stale');
  }

  private async recover(
    ctx: TelegramContext,
    reason: 'stale' | 'updating' | 'unavailable',
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog;
    if (!catalog) return;
    if (reason === 'updating') {
      await ctx.reply(catalog.home.recovery.updating);
      return;
    }
    if (reason === 'unavailable') {
      await ctx.reply(catalog.home.recovery.unavailable);
      return;
    }
    await ctx.reply(catalog.home.recovery.stale, {
      reply_markup: new InlineKeyboard().text(catalog.home.recovery.openNewHome, OPEN_NEW_HOME_CALLBACK),
    });
  }

  private current(ctx: TelegramContext): { userId: number; chatId: number; state: LocaleState } | null {
    const userId = ctx.from?.id;
    const chat = ctx.chat;
    const state = ctx.localeState;
    if (!userId || chat?.type !== 'private' || !state || state.user.telegramId !== userId) return null;
    return { userId, chatId: chat.id, state };
  }
}
