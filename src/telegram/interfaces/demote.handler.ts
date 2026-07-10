import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { DemoteUserUseCase } from '../application/demote-user.use-case';
import { LastAdminDemotionError } from '../domain/errors/last-admin-demotion.error';
import { NotAdminError } from '../domain/errors/not-admin.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  DIRECT_MESSENGER,
  DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import { RoleMiddleware } from './role.middleware';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class DemoteHandler implements TelegramHandler {
  private readonly logger = new Logger(DemoteHandler.name);

  constructor(
    private readonly demote: DemoteUserUseCase,
    private readonly guard: RoleMiddleware,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
    private readonly botCommandsMenu: BotCommandsMenuService,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('demote', this.guard.adminOnly, async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await ctx.reply(en.users.missingTarget('demote'));
        return;
      }
      try {
        const demoted = await this.demote.execute(target);
        await ctx.reply(en.users.demoted(demoted.name));
        await this.botCommandsMenu.updateUserMenu(demoted.telegramId, 'user');
        const adminName = from.first_name || from.username || `user-${from.id}`;
        await this.dm.send(
          demoted.telegramId,
          en.users.demotedNotice(adminName),
        );
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          await ctx.reply(en.users.userNotFound);
          return;
        }
        if (err instanceof NotAdminError) {
          await ctx.reply(en.users.alreadyUser(err.name));
          return;
        }
        if (err instanceof LastAdminDemotionError) {
          await ctx.reply(en.users.finalAdmin);
          return;
        }
        this.logger.error(
          `/demote failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.users.demoteFailed);
      }
    });
  }
}
