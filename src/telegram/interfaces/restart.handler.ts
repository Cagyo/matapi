import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { RestartSystemUseCase } from '../application/restart-system.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

@Injectable()
export class RestartHandler implements TelegramHandler {
  private readonly logger = new Logger(RestartHandler.name);

  constructor(
    private readonly restart: RestartSystemUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'system-restart', {
      source: 'natural-parent',
    });
    if (!receipt || !await this.workflows.markRunning(ctx, receipt)) return;

    try {
      await ctx.reply((ctx.localeState?.catalog ?? en).ota.restarting);
      await this.restart.execute();
    } catch (err) {
      this.logger.error(
        `/restart failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      const catalog = ctx.localeState?.catalog ?? en;
      const text = catalog.ota.restartFailed((err as Error).message);
      if (this.navigation) {
        await this.navigation.complete(ctx, { receipt }, {
          effectStage: 'pending',
          deliver: async () => { await ctx.reply(text); },
          failureNotice: catalog.home.recovery.unavailable,
        });
        return;
      }
      await ctx.reply(text);
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('restart', this.guard.adminOnly, async (ctx: TelegramContext) => {
      await this.handleCommand(ctx);
    });
  }
}
