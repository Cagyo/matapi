import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { catalogFor, type LocaleCatalog } from '../../locales';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import { isLocale, type Locale } from '../domain/locale';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

const DEFAULT_THRESHOLD = 80;

@Injectable()
export class SettingsHandler implements TelegramHandler {
  private readonly logger = new Logger(SettingsHandler.name);

  constructor(
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly botCommandsMenu: BotCommandsMenuService,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('settings', this.guard.registered, (ctx) => this.handleCommand(ctx));
    composer.callbackQuery(/^settings:locale:(.+)$/, this.guard.registered, (ctx) => this.changeLocale(ctx));
    composer.callbackQuery(/^settings:set:(\d+)$/, this.guard.adminOnly, (ctx) => this.setThreshold(ctx));
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    await this.renderDashboard(ctx, false);
  }

  private async changeLocale(ctx: TelegramContext): Promise<void> {
    const requested = ctx.match?.[1];
    const currentCatalog = this.catalog(ctx);
    if (!isLocale(requested) || !ctx.from) {
      await ctx.answerCallbackQuery({ text: currentCatalog.common.failure('Invalid language'), show_alert: true }).catch(() => undefined);
      return;
    }

    try {
      const user = await this.users.setLocale(ctx.from.id, requested);
      const catalog = catalogFor(requested);
      ctx.localeState = { user, locale: requested, catalog };
      await ctx.answerCallbackQuery(catalog.language.updated(catalog.language.buttons[requested])).catch(() => undefined);
      await this.renderDashboard(ctx, true);
      void this.botCommandsMenu.updateUserMenu(ctx.from.id).catch((err: Error) => {
        this.logger.warn(`Failed to queue localized menu for ${ctx.from!.id}: ${err.message}`);
      });
    } catch (err) {
      this.logger.error(`Failed to set locale: ${(err as Error).message}`, (err as Error).stack);
      await ctx.answerCallbackQuery({ text: currentCatalog.common.error('update language', (err as Error).message), show_alert: true }).catch(() => undefined);
    }
  }

  private async setThreshold(ctx: TelegramContext): Promise<void> {
    const match = ctx.match?.[1];
    if (!match) return;
    const value = Number(match);
    const catalog = this.catalog(ctx);
    if (!Number.isFinite(value) || value < 10 || value > 99) {
      await ctx.answerCallbackQuery({ text: catalog.settings.invalidThreshold, show_alert: true }).catch(() => undefined);
      return;
    }

    try {
      await this.meta.set('auto_clean_threshold', Math.trunc(value).toString());
      await ctx.answerCallbackQuery(catalog.settings.updated(value)).catch(() => undefined);
      await this.renderDashboard(ctx, true);
    } catch (err) {
      this.logger.error(`Failed to set auto_clean_threshold: ${(err as Error).message}`, (err as Error).stack);
      await ctx.answerCallbackQuery({ text: catalog.common.error('update setting', (err as Error).message), show_alert: true }).catch(() => undefined);
    }
  }

  private async renderDashboard(ctx: TelegramContext, isEdit: boolean): Promise<void> {
    try {
      const catalog = this.catalog(ctx);
      const isAdmin = ctx.localeState?.user.role === 'admin';
      const threshold = isAdmin ? await this.getThreshold() : null;
      const text = this.dashboardText(catalog, ctx.localeState?.locale ?? 'en', threshold);
      const keyboard = this.buildKeyboard(catalog, isAdmin);
      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' }).catch(() => undefined);
      } else {
        await ctx.reply(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
      }
    } catch (err) {
      this.logger.error(`Failed to render settings dashboard: ${(err as Error).message}`, (err as Error).stack);
      await ctx.reply(this.catalog(ctx).common.error('load settings', (err as Error).message));
    }
  }

  private dashboardText(catalog: LocaleCatalog, locale: Locale, threshold: number | null): string {
    const language = `${catalog.language.prompt}\n${catalog.language.current(catalog.language.buttons[locale])}`;
    return threshold === null ? language : `${catalog.settings.title(threshold)}\n\n${language}`;
  }

  private buildKeyboard(catalog: LocaleCatalog, isAdmin: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text(catalog.language.buttons.en, 'settings:locale:en')
      .text(catalog.language.buttons.ru, 'settings:locale:ru')
      .text(catalog.language.buttons.uk, 'settings:locale:uk');
    if (!isAdmin) return keyboard;
    return keyboard.row()
      .text(catalog.settings.buttons.t70, 'settings:set:70')
      .text(catalog.settings.buttons.t75, 'settings:set:75')
      .text(catalog.settings.buttons.t80, 'settings:set:80')
      .row()
      .text(catalog.settings.buttons.t85, 'settings:set:85')
      .text(catalog.settings.buttons.t90, 'settings:set:90')
      .row()
      .text(catalog.settings.buttons.cleanNow, 'clean:trigger');
  }

  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

  private async getThreshold(): Promise<number> {
    try {
      const raw = await this.meta.get('auto_clean_threshold');
      if (raw !== null) {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 10 && value <= 99) return Math.trunc(value);
      }
      const envValue = Number(process.env.DISK_CRITICAL_PERCENT);
      if (Number.isFinite(envValue) && envValue >= 10 && envValue <= 99) return Math.trunc(envValue);
    } catch (err) {
      this.logger.warn(`Failed to read auto_clean_threshold: ${(err as Error).message}`);
    }
    return DEFAULT_THRESHOLD;
  }
}
