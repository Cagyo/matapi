import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { InviteUseCase } from '../application/invite.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

@Injectable()
export class InviteHandler implements TelegramHandler {
  private readonly logger = new Logger(InviteHandler.name);

  constructor(
    private readonly invite: InviteUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('invite', this.guard.adminOnly, (ctx: TelegramContext) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'invite', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const invite = await this.invite.execute({ invitedBy: from.id });
      await this.complete(ctx, receipt, async () => { await ctx.reply(catalog.users.inviteIssued(invite.code)); });
    } catch (err) {
      this.logger.error(
        `/invite failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.complete(ctx, receipt, async () => { await ctx.reply(catalog.users.inviteFailed); });
    }
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    deliver: () => Promise<void>,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver,
        failureNotice: catalog.home.recovery.unavailable,
      });
      return;
    }
    await deliver();
  }
}
