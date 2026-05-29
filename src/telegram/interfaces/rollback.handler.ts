import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { RollbackSystemUseCase } from '../application/rollback-system.use-case';
import { NoRollbackTagError } from '../../system/domain/errors/no-rollback-tag.error';
import { UpdateInProgressError } from '../../system/domain/errors/update-in-progress.error';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class RollbackHandler implements TelegramHandler {
  private readonly logger = new Logger(RollbackHandler.name);

  constructor(
    private readonly rollback: RollbackSystemUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('rollback', this.guard.adminOnly, async (ctx: Context) => {
      try {
        await ctx.reply(en.ota.rollbackStarting);
        await this.rollback.execute();
      } catch (err) {
        if (err instanceof UpdateInProgressError) {
          await ctx.reply(en.ota.inProgress);
          return;
        }
        if (err instanceof NoRollbackTagError) {
          await ctx.reply(en.ota.rollbackNoTag);
          return;
        }
        this.logger.error(
          `/rollback failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.ota.rollbackFailed((err as Error).message));
      }
    });
  }
}
