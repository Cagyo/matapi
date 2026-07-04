import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InlineKeyboard } from 'grammy';
import { en, TYPE_ICONS } from '../../locales/en';
import { MuteSensorUseCase } from '../application/mute-sensor.use-case';
import { SensorAlreadyMutedError } from '../domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class MuteHandler implements TelegramHandler {
  private readonly logger = new Logger(MuteHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly mute: MuteSensorUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('mute', this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        const sensors = await this.sensors.listEnabled();
        if (sensors.length === 0) {
          await ctx.reply(en.status.none);
          return;
        }
        const kb = new InlineKeyboard();
        for (const s of sensors) {
          const icon = TYPE_ICONS[s.type] ?? '•';
          kb.text(`${icon} ${s.name}`, `mute:${s.name}`).row();
        }
        await ctx.reply(en.mute.selectMute, { reply_markup: kb });
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

    composer.callbackQuery(/^mute:/, this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      const target = (ctx.callbackQuery?.data ?? '').slice('mute:'.length).trim();
      if (!target) return;
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
          `/mute callback failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.mute.muteFailed);
      }
    });
  }
}
