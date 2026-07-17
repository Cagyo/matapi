import { Injectable, Optional } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext } from './telegram-context';
import { TelegramHandler } from './telegram-handler';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

@Injectable()
export class HelpHandler implements TelegramHandler {
  constructor(
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('help', this.guard.registered, async (ctx) => {
      await this.handleCommand(ctx);
    });
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'help', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    const text = ctx.localeState?.user.role === 'admin' ? catalog.help.admin : catalog.help.user;
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
