import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer } from 'grammy';
import { TriggerCleanUseCase } from '../../camera/application/trigger-clean.use-case';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

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
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
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

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'storage-cleanup', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const arg = (ctx.match ?? '').toString().trim();
    let customThreshold: number | undefined;

    if (arg) {
      const val = Number(arg);
      if (!Number.isFinite(val) || val < 10 || val > 99 || !Number.isInteger(val)) {
        await this.complete(ctx, receipt, () => ctx.reply((ctx.localeState?.catalog ?? en).clean.invalidThreshold));
        return;
      }
      customThreshold = val;
    }

    await this.executeCleanup(ctx, customThreshold, { receipt });
  }

  private async executeCleanup(
    ctx: TelegramContext,
    customThreshold?: number,
    launch?: WorkflowLaunch,
  ): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'storage-cleanup', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const res = await this.triggerClean.execute(customThreshold);
      if (!res.executed) {
        await this.complete(ctx, receipt, () => ctx.reply(catalog.clean.inProgress));
        return;
      }
      await this.complete(ctx, receipt, () => ctx.reply(catalog.clean.triggered(res.thresholdUsed), {
        parse_mode: 'Markdown',
      }));
    } catch (err) {
      this.logger.error(`Manual clean failed: ${(err as Error).message}`, (err as Error).stack);
      await this.complete(ctx, receipt, () => ctx.reply(catalog.common.error('trigger cleanup', (err as Error).message)));
    }
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await deliver(); },
        failureNotice: catalog.home.recovery.unavailable,
      });
      return;
    }
    await deliver();
  }
}
