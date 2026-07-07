import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

const DEFAULT_THRESHOLD = 80;

/**
 * `/settings` — spec 15. Admin-only interactive dashboard for viewing and
 * modifying runtime system settings, specifically the auto-clean trigger
 * threshold, using thumb-friendly inline buttons.
 */
@Injectable()
export class SettingsHandler implements TelegramHandler {
  private readonly logger = new Logger(SettingsHandler.name);

  constructor(
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('settings', this.guard.adminOnly, async (ctx) => {
      await this.handleCommand(ctx);
    });

    composer.callbackQuery(
      /^settings:set:(\d+)$/,
      this.guard.adminOnly,
      async (ctx) => {
        const match = ctx.match?.[1];
        if (!match) return;
        const val = Number(match);
        if (!Number.isFinite(val) || val < 10 || val > 99) {
          await ctx.answerCallbackQuery({ text: en.settings.invalidThreshold, show_alert: true }).catch(() => {});
          return;
        }

        try {
          await this.meta.set('auto_clean_threshold', Math.trunc(val).toString());
          await ctx.answerCallbackQuery(en.settings.updated(val)).catch(() => {});
          await this.renderDashboard(ctx, true);
        } catch (err) {
          this.logger.error(`Failed to set auto_clean_threshold: ${(err as Error).message}`, (err as Error).stack);
          await ctx.answerCallbackQuery({ text: en.common.error('update setting', (err as Error).message), show_alert: true }).catch(() => {});
        }
      },
    );
  }

  async handleCommand(ctx: Context): Promise<void> {
    await this.renderDashboard(ctx, false);
  }

  private async renderDashboard(ctx: Context, isEdit: boolean): Promise<void> {
    try {
      const threshold = await this.getThreshold();
      const text = en.settings.title(threshold);
      const kb = this.buildKeyboard();

      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, {
          reply_markup: kb,
          parse_mode: 'Markdown',
        }).catch(() => {});
      } else {
        await ctx.reply(text, {
          reply_markup: kb,
          parse_mode: 'Markdown',
        });
      }
    } catch (err) {
      this.logger.error(`Failed to render settings dashboard: ${(err as Error).message}`, (err as Error).stack);
      await ctx.reply(en.common.error('load settings', (err as Error).message));
    }
  }

  private async getThreshold(): Promise<number> {
    try {
      const raw = await this.meta.get('auto_clean_threshold');
      if (raw !== null) {
        const val = Number(raw);
        if (Number.isFinite(val) && val >= 10 && val <= 99) {
          return Math.trunc(val);
        }
      }
      const envVal = Number(process.env.DISK_CRITICAL_PERCENT);
      if (Number.isFinite(envVal) && envVal >= 10 && envVal <= 99) {
        return Math.trunc(envVal);
      }
    } catch (err) {
      this.logger.warn(`Failed to read auto_clean_threshold: ${(err as Error).message}`);
    }
    return DEFAULT_THRESHOLD;
  }

  private buildKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text(en.settings.buttons.t70, 'settings:set:70')
      .text(en.settings.buttons.t75, 'settings:set:75')
      .text(en.settings.buttons.t80, 'settings:set:80')
      .row()
      .text(en.settings.buttons.t85, 'settings:set:85')
      .text(en.settings.buttons.t90, 'settings:set:90')
      .row()
      .text(en.settings.buttons.cleanNow, 'clean:trigger')
      .text(en.gdriveAuth.button, 'gdauth:start');
  }
}
