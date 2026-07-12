import { Injectable, Logger } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { InviteUseCase } from '../application/invite.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class InviteHandler implements TelegramHandler {
  private readonly logger = new Logger(InviteHandler.name);

  constructor(
    private readonly invite: InviteUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('invite', this.guard.adminOnly, (ctx: TelegramContext) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    try {
      const invite = await this.invite.execute({ invitedBy: from.id });
      await ctx.reply(en.users.inviteIssued(invite.code));
    } catch (err) {
      this.logger.error(
        `/invite failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.users.inviteFailed);
    }
  }
}
