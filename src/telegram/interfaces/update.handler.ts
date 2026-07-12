import { Injectable, Logger } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import { UpdateSystemUseCase } from '../application/update-system.use-case';
import { OtaCheckFailedError } from '../../system/domain/errors/ota-check-failed.error';
import { UpdateInProgressError } from '../../system/domain/errors/update-in-progress.error';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class UpdateHandler implements TelegramHandler {
  private readonly logger = new Logger(UpdateHandler.name);

  constructor(
    private readonly update: UpdateSystemUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('update', this.guard.adminOnly, async (ctx: TelegramContext) => {
      try {
        await ctx.reply(en.ota.checking);
        const outcome = await this.update.execute();
        if (outcome.kind === 'up-to-date') {
          await ctx.reply(en.ota.upToDate);
          return;
        }
        await ctx.reply(en.ota.updating(outcome.commit.slice(0, 7)));
      } catch (err) {
        if (err instanceof UpdateInProgressError) {
          await ctx.reply(en.ota.inProgress);
          return;
        }
        if (err instanceof OtaCheckFailedError) {
          await ctx.reply(en.ota.fetchFailed(err.reason));
          return;
        }
        this.logger.error(
          `/update failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.ota.fetchFailed((err as Error).message));
      }
    });
  }
}
