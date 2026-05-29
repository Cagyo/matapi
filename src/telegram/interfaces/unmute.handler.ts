import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { UnmuteSensorUseCase } from '../application/unmute-sensor.use-case';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../domain/errors/sensor-not-muted.error';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class UnmuteHandler implements TelegramHandler {
  private readonly logger = new Logger(UnmuteHandler.name);

  constructor(
    private readonly unmute: UnmuteSensorUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('unmute', this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await ctx.reply(en.mute.missingSensorUnmute);
        return;
      }
      try {
        await this.unmute.execute(userId, target);
        await ctx.reply(en.mute.unmuted(target));
      } catch (err) {
        if (err instanceof SensorNotFoundError) {
          await ctx.reply(en.mute.notFound(err.name));
          return;
        }
        if (err instanceof SensorNotMutedError) {
          await ctx.reply(en.mute.notMuted(err.name));
          return;
        }
        this.logger.error(
          `/unmute failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.mute.unmuteFailed);
      }
    });
  }
}
