import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { SetQuietHoursUseCase } from '../application/set-quiet-hours.use-case';
import { InvalidQuietHoursError } from '../domain/errors/invalid-quiet-hours.error';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class QuietHoursHandler implements TelegramHandler {
  private readonly logger = new Logger(QuietHoursHandler.name);

  constructor(
    private readonly setQuietHours: SetQuietHoursUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command(
      'quiet_hours',
      this.guard.registered,
      async (ctx: Context) => {
        const userId = ctx.from?.id;
        if (!userId) return;
        const raw = (ctx.match ?? '').toString().trim();
        if (!raw) {
          await ctx.reply(en.quietHours.invalidFormat);
          return;
        }
        try {
          const result = await this.setQuietHours.execute(userId, raw);
          if (result.start === null || result.end === null) {
            await ctx.reply(en.quietHours.disabled);
          } else {
            await ctx.reply(en.quietHours.set(result.start, result.end));
          }
        } catch (err) {
          if (err instanceof InvalidQuietHoursError) {
            await ctx.reply(
              err.reason === 'format'
                ? en.quietHours.invalidFormat
                : en.quietHours.invalidTime,
            );
            return;
          }
          this.logger.error(
            `/quiet_hours failed: ${(err as Error).message}`,
            (err as Error).stack,
          );
          await ctx.reply(en.quietHours.setFailed);
        }
      },
    );
  }
}
