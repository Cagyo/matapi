import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { PromoteUserUseCase } from '../application/promote-user.use-case';
import { AlreadyAdminError } from '../domain/errors/already-admin.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  DIRECT_MESSENGER,
  DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class PromoteHandler implements TelegramHandler {
  private readonly logger = new Logger(PromoteHandler.name);

  constructor(
    private readonly promote: PromoteUserUseCase,
    private readonly guard: RoleMiddleware,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('promote', this.guard.adminOnly, async (ctx: Context) => {
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
