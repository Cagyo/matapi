import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { ClaimAdminUseCase } from '../application/claim-admin.use-case';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import { AdminAlreadyClaimedError } from '../domain/errors/admin-already-claimed.error';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class ClaimAdminHandler implements TelegramHandler {
  private readonly logger = new Logger(ClaimAdminHandler.name);

  constructor(
    private readonly claimAdmin: ClaimAdminUseCase,
    private readonly botCommandsMenu: BotCommandsMenuService,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('claim_admin', async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;

      try {
        await this.claimAdmin.execute({
          telegramId: from.id,
          name: from.first_name || from.username || `user-${from.id}`,
        });
        await ctx.reply(en.claim.success);
        await this.botCommandsMenu.updateUserMenu(from.id, 'admin');
      } catch (err) {
        if (err instanceof AdminAlreadyClaimedError) {
          await ctx.reply(en.claim.alreadyClaimed);
          return;
        }
        this.logger.error(
          `/claim_admin failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.common.error('claim admin', 'internal error'));
      }
    });
  }
}
