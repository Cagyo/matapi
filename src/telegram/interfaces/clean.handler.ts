import { Injectable, Logger } from '@nestjs/common';
import { Composer } from 'grammy';
import { TriggerCleanUseCase } from '../../camera/application/trigger-clean.use-case';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

/**
 * `/clean` & callback triggers — spec 15. Admin-only. Manually triggers a
 * storage cleanup across local disk and Google Drive, reporting the result
 * and the threshold percentage used.
 */
@Injectable()
export class CleanHandler implements TelegramHandler {
  private readonly logger = new Logger(CleanHandler.name);

  constructor(
    private readonly triggerClean: TriggerCleanUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('clean', this.guard.adminOnly, async (ctx) => {
      await this.handleCommand(ctx);
    });

    composer.callbackQuery(
      /^(?:clean:trigger|legacy-menu:clean)$/,
      this.guard.adminOnly,
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        await this.executeCleanup(ctx);
      },
    );
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    const arg = (ctx.match ?? '').toString().trim();
    let customThreshold: number | undefined;

    if (arg) {
      const val = Number(arg);
      if (!Number.isFinite(val) || val < 10 || val > 99 || !Number.isInteger(val)) {
        await ctx.reply(en.clean.invalidThreshold);
        return;
      }
      customThreshold = val;
    }

    await this.executeCleanup(ctx, customThreshold);
  }

  private async executeCleanup(ctx: TelegramContext, customThreshold?: number): Promise<void> {
    try {
      const res = await this.triggerClean.execute(customThreshold);
      if (!res.executed) {
        await ctx.reply(en.clean.inProgress);
        return;
      }
      await ctx.reply(en.clean.triggered(res.thresholdUsed), {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      this.logger.error(`Manual clean failed: ${(err as Error).message}`, (err as Error).stack);
      await ctx.reply(en.common.error('trigger cleanup', (err as Error).message));
    }
  }
}
