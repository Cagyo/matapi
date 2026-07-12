import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { RegisterUserUseCase } from '../application/register-user.use-case';
import { AlreadyRegisteredError } from '../domain/errors/already-registered.error';
import { InvalidInviteCodeError } from '../domain/errors/invalid-invite-code.error';
import { InviteCodeUsedError } from '../domain/errors/invite-code-used.error';
import {
  DIRECT_MESSENGER,
  DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class StartHandler implements TelegramHandler {
  private readonly logger = new Logger(StartHandler.name);

  constructor(
    private readonly registerUser: RegisterUserUseCase,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
    private readonly botCommandsMenu: BotCommandsMenuService,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('start', async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;

      const code = (ctx.match ?? '').toString().trim();
      if (!code) {
        await ctx.reply(en.users.startNoCode);
        return;
      }

      try {
        const result = await this.registerUser.execute({
          telegramId: from.id,
          name: from.first_name || from.username || `user-${from.id}`,
          code,
        });
        await ctx.reply(en.users.welcomed(result.user.name));
        await this.botCommandsMenu.updateUserMenu(from.id, result.user.role);

        if (result.invitedBy !== null) {
          await this.dm.send(
            result.invitedBy,
            en.users.joinedNotice(result.user.name),
          );
        }
      } catch (err) {
        if (err instanceof InvalidInviteCodeError) {
          await ctx.reply(en.users.invalidCode);
          return;
        }
        if (err instanceof InviteCodeUsedError) {
          await ctx.reply(en.users.codeUsed);
          return;
        }
        if (err instanceof AlreadyRegisteredError) {
          await ctx.reply(en.users.alreadyRegistered);
          return;
        }
        this.logger.error(
          `/start failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.users.registerFailed);
      }
    });
  }
}
