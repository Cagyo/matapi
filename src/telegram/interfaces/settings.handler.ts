import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import { isLocale, type Locale } from '../domain/locale';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class SettingsHandler implements TelegramHandler {
  private readonly logger = new Logger(SettingsHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly botCommandsMenu: BotCommandsMenuService,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('settings', this.guard.registered, (ctx) => this.handleCommand(ctx));
    composer.callbackQuery(/^settings:locale:(.+)$/, this.guard.registered, (ctx) => this.changeLocale(ctx));
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

  private async renderDashboard(ctx: TelegramContext, isEdit: boolean): Promise<void> {
    try {
      const catalog = this.catalog(ctx);
      const text = this.dashboardText(catalog, ctx.localeState?.locale ?? 'en');
      const keyboard = this.buildKeyboard(catalog);
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

  private dashboardText(catalog: LocaleCatalog, locale: Locale): string {
    const language = `${catalog.language.prompt}\n${catalog.language.current(catalog.language.buttons[locale])}`;
    return language;
  }

  private buildKeyboard(catalog: LocaleCatalog): InlineKeyboard {
    return new InlineKeyboard()
      .text(catalog.language.buttons.en, 'settings:locale:en')
      .text(catalog.language.buttons.ru, 'settings:locale:ru')
      .text(catalog.language.buttons.uk, 'settings:locale:uk');
  }

  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

}
