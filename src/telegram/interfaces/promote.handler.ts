import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { PromoteUserUseCase } from '../application/promote-user.use-case';
import { AlreadyAdminError } from '../domain/errors/already-admin.error';
import { AmbiguousUserTargetError } from '../domain/errors/ambiguous-user-target.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  DIRECT_MESSENGER,
  DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import { RoleMiddleware } from './role.middleware';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class PromoteHandler implements TelegramHandler {
  private readonly logger = new Logger(PromoteHandler.name);

  constructor(
    private readonly promote: PromoteUserUseCase,
    private readonly guard: RoleMiddleware,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
    private readonly botCommandsMenu: BotCommandsMenuService,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('promote', this.guard.adminOnly, async (ctx: TelegramContext) => {
      const from = ctx.from;
      if (!from) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await ctx.reply(en.users.missingTarget('promote'));
        return;
      }
      try {
        const promoted = await this.promote.execute(target);
        await ctx.reply(en.users.promoted(promoted.name));
        await this.botCommandsMenu.updateUserMenu(promoted.telegramId);
        const adminName = from.first_name || from.username || `user-${from.id}`;
        await this.dm.send(
          promoted.telegramId,
          en.users.promotedNotice(adminName),
        );
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          await ctx.reply(en.users.userNotFound);
          return;
        }
        if (err instanceof AmbiguousUserTargetError) {
          await ctx.reply(en.users.ambiguousTarget('promote', err.matches));
          return;
        }
        if (err instanceof AlreadyAdminError) {
          await ctx.reply(en.users.alreadyAdmin(err.name));
          return;
        }
        this.logger.error(
          `/promote failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.users.promoteFailed);
      }
    });
  }
}
