import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { RestartSystemUseCase } from '../application/restart-system.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class RestartHandler implements TelegramHandler {
  private readonly logger = new Logger(RestartHandler.name);

  constructor(
    private readonly restart: RestartSystemUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  async handleCommand(ctx: Context): Promise<void> {
    try {
      await ctx.reply(en.ota.restarting);
      await this.restart.execute();
    } catch (err) {
      this.logger.error(
        `/restart failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.ota.restartFailed((err as Error).message));
    }
  }

  register(composer: Composer<Context>): void {
    composer.command('restart', this.guard.adminOnly, async (ctx: Context) => {
      await this.handleCommand(ctx);
    });
  }
}
