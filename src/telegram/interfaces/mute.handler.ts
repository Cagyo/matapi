import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import { MuteSensorUseCase } from '../application/mute-sensor.use-case';
import { SensorAlreadyMutedError } from '../domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class MuteHandler implements TelegramHandler {
  private readonly logger = new Logger(MuteHandler.name);

  constructor(
    private readonly mute: MuteSensorUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('mute', this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await ctx.reply(en.mute.missingSensor);
        return;
      }
      try {
        await this.mute.execute(userId, target);
        await ctx.reply(en.mute.muted(target));
      } catch (err) {
        if (err instanceof SensorNotFoundError) {
          await ctx.reply(en.mute.notFound(err.name));
          return;
        }
        if (err instanceof SensorAlreadyMutedError) {
          await ctx.reply(en.mute.alreadyMuted(err.name));
          return;
        }
        this.logger.error(
          `/mute failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.mute.muteFailed);
      }
    });
  }
}
