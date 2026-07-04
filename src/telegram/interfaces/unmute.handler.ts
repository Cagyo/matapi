import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InlineKeyboard } from 'grammy';
import { en, TYPE_ICONS } from '../../locales/en';
import { UnmuteSensorUseCase } from '../application/unmute-sensor.use-case';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../domain/errors/sensor-not-muted.error';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class UnmuteHandler implements TelegramHandler {
  private readonly logger = new Logger(UnmuteHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly unmute: UnmuteSensorUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  async handleEmpty(ctx: Context): Promise<void> {
    const sensors = await this.sensors.listEnabled();
    if (sensors.length === 0) {
      await ctx.reply(en.status.none);
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of sensors) {
      const icon = TYPE_ICONS[s.type] ?? '•';
      kb.text(`${icon} ${s.name}`, `unmute:${s.name}`).row();
    }
    await ctx.reply(en.mute.selectUnmute, { reply_markup: kb });
  }

  register(composer: Composer<Context>): void {
    composer.command('unmute', this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await this.handleEmpty(ctx);
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

    composer.callbackQuery(/^unmute:/, this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      const target = (ctx.callbackQuery?.data ?? '').slice('unmute:'.length).trim();
      if (!target) return;
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
          `/unmute callback failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.mute.unmuteFailed);
      }
    });
  }
}
