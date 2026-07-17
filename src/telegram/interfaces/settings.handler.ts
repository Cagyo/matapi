import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import { isLocale, type Locale } from '../domain/locale';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { RoleMiddleware } from './role.middleware';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import {
  WorkflowDraftRegistry,
  type WorkflowDraftCanceller,
} from './workflow-draft.registry';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

interface LanguageState {
  userId: number;
  chatId: number;
  receiptId: string;
  receipt: WorkflowReturnReceipt;
}

const LOCALE_CALLBACK = /^settings:locale:([A-Za-z0-9_-]{16}):(en|ru|uk)$/;

@Injectable()
export class SettingsHandler implements TelegramHandler, WorkflowDraftCanceller {
  private readonly logger = new Logger(SettingsHandler.name);
  private readonly states = new Map<string, LanguageState>();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly botCommandsMenu: BotCommandsMenuService,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly drafts: WorkflowDraftRegistry,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {
    this.drafts.register('language', this);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('settings', this.guard.registered, (ctx) => this.handleCommand(ctx));
    composer.callbackQuery(/^settings:locale:/, this.guard.registered, (ctx) => this.changeLocale(ctx));
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'language', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const state = this.setState(receipt);
    await this.renderDashboard(ctx, state);
  }

  async cancelExact(input: {
    userId: number;
    chatId: number;
    receiptId: string;
  }): Promise<'cancelled' | 'missing' | 'superseded'> {
    const key = stateKey(input.userId, input.chatId);
    const state = this.states.get(key);
    if (!state) return 'missing';
    if (state.receiptId !== input.receiptId) return 'superseded';
    this.states.delete(key);
    return 'cancelled';
  }

  private async changeLocale(ctx: TelegramContext): Promise<void> {
    const parsed = parseLocaleCallback(ctx.callbackQuery?.data ?? '');
    await ctx.answerCallbackQuery().catch(() => undefined);
    const state = this.stateFor(ctx);
    if (parsed?.receiptId !== state?.receiptId) return;
    if (!parsed || !state || !ctx.from) return;

    const currentCatalog = this.catalog(ctx);
    try {
      const user = await this.users.setLocale(ctx.from.id, parsed.locale);
      const catalog = catalogFor(parsed.locale);
      ctx.localeState = { user, locale: parsed.locale, catalog };
      await ctx.answerCallbackQuery(catalog.language.updated(catalog.language.buttons[parsed.locale])).catch(() => undefined);
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, catalog.language.updated(catalog.language.buttons[parsed.locale])),
        failureNotice: catalog.language.restoreMoreFailed,
      });
      void this.botCommandsMenu.updateUserMenu(ctx.from.id).catch((err: Error) => {
        this.logger.warn(`Failed to queue localized menu for ${ctx.from!.id}: ${err.message}`);
      });
    } catch (err) {
      this.logger.error(`Failed to set locale: ${(err as Error).message}`, (err as Error).stack);
      await ctx.reply(currentCatalog.language.updateFailed, {
        reply_markup: this.retryKeyboard(currentCatalog, state, parsed.locale),
      }).catch(() => undefined);
    }
  }

  private async renderDashboard(ctx: TelegramContext, state: LanguageState): Promise<void> {
    try {
      const catalog = this.catalog(ctx);
      const text = this.dashboardText(catalog, ctx.localeState?.locale ?? 'en');
      await ctx.reply(text, {
        reply_markup: this.buildKeyboard(catalog, state),
        parse_mode: 'Markdown',
      });
    } catch (err) {
      this.logger.error(`Failed to render settings dashboard: ${(err as Error).message}`, (err as Error).stack);
      await ctx.reply(this.catalog(ctx).common.error('load settings', (err as Error).message));
    }
  }

  private dashboardText(catalog: LocaleCatalog, locale: Locale): string {
    return `${catalog.language.prompt}\n${catalog.language.current(catalog.language.buttons[locale])}`;
  }

  private buildKeyboard(catalog: LocaleCatalog, state: LanguageState): InlineKeyboard {
    return new InlineKeyboard()
      .text(catalog.language.buttons.en, localeCallback(state.receiptId, 'en'))
      .text(catalog.language.buttons.ru, localeCallback(state.receiptId, 'ru'))
      .text(catalog.language.buttons.uk, localeCallback(state.receiptId, 'uk'))
      .row()
      .text(catalog.language.returnToMore, workflowReturnCallback(state.receiptId, 'origin'))
      .text(catalog.home.common.home, workflowReturnCallback(state.receiptId, 'home'));
  }

  private retryKeyboard(
    catalog: LocaleCatalog,
    state: LanguageState,
    locale: Locale,
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text(catalog.language.retryLanguageChange, localeCallback(state.receiptId, locale))
      .row()
      .text(catalog.language.returnToMore, workflowReturnCallback(state.receiptId, 'origin'));
  }

  private setState(receipt: WorkflowReturnReceipt): LanguageState {
    const state = {
      userId: receipt.userId,
      chatId: receipt.chatId,
      receiptId: receipt.id,
      receipt,
    };
    this.states.set(stateKey(state.userId, state.chatId), state);
    return state;
  }

  private stateFor(ctx: TelegramContext): LanguageState | null {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) return null;
    if (ctx.chat?.type !== 'private') return null;
    return this.states.get(stateKey(userId, ctx.chat.id)) ?? null;
  }

  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

  private async reply(ctx: TelegramContext, text: string): Promise<void> {
    await ctx.reply(text);
  }

  private async complete(
    ctx: TelegramContext,
    state: LanguageState,
    presentation: {
      effectStage: 'pending' | 'already-delivered';
      deliver(): Promise<void>;
      failureNotice: string;
    },
  ): Promise<void> {
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt: state.receipt }, presentation);
      return;
    }
    if (presentation.effectStage === 'pending') await presentation.deliver();
    await this.cancelExact({
      userId: state.userId,
      chatId: state.chatId,
      receiptId: state.receiptId,
    });
  }
}

function stateKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function localeCallback(receiptId: string, locale: Locale): string {
  return `settings:locale:${receiptId}:${locale}`;
}

function parseLocaleCallback(data: string): { receiptId: string; locale: Locale } | null {
  const match = LOCALE_CALLBACK.exec(data);
  if (!match || !isLocale(match[2])) return null;
  return { receiptId: match[1], locale: match[2] };
}
