import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../../camera/domain/ports/media-repository.port';
import { en, TYPE_ICONS } from '../../locales/en';
import { UnmuteSensorUseCase } from '../application/unmute-sensor.use-case';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../domain/errors/sensor-not-muted.error';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext } from './telegram-context';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class UnmuteHandler implements TelegramHandler {
  private readonly logger = new Logger(UnmuteHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly unmute: UnmuteSensorUseCase,
    private readonly guard: RoleMiddleware,
    @Optional()
    @Inject(MEDIA_REPOSITORY)
    private readonly media?: MediaRepositoryPort,
  ) {}

  async handleEmpty(ctx: TelegramContext): Promise<void> {
    const sensors = await this.sensors.listEnabled();
    const cameras = this.media
      ? (await this.media.listCameras()).filter((c) => c.enabled)
      : [];
    if (sensors.length === 0 && cameras.length === 0) {
      await ctx.reply(en.status.none);
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of sensors) {
      const icon = TYPE_ICONS[s.type] ?? '•';
      kb.text(`${icon} ${s.name}`, `unmute:${s.name}`).row();
    }
    for (const c of cameras) {
      const icon = TYPE_ICONS.camera ?? '📷';
      kb.text(`${icon} ${c.name}`, `unmute:${c.name}`).row();
    }
    await ctx.reply(en.mute.selectUnmute, { reply_markup: kb });
  }

  async handleUnmuteAll(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const sensors = await this.sensors.listEnabled();
    const cameras = this.media
      ? (await this.media.listCameras()).filter((c) => c.enabled)
      : [];
    if (sensors.length === 0 && cameras.length === 0) {
      await ctx.reply(en.mute.noSensorsToUnmute);
      return;
    }
    let unmutedCount = 0;
    for (const s of sensors) {
      try {
        await this.unmute.execute(userId, s.name);
        unmutedCount++;
      } catch (err) {
        if (!(err instanceof SensorNotMutedError)) {
          this.logger.error(`Failed to unmute ${s.name}: ${(err as Error).message}`);
        }
      }
    }
    for (const c of cameras) {
      try {
        await this.unmute.execute(userId, c.name);
        unmutedCount++;
      } catch (err) {
        if (!(err instanceof SensorNotMutedError)) {
          this.logger.error(`Failed to unmute ${c.name}: ${(err as Error).message}`);
        }
      }
    }
    if (unmutedCount === 0) {
      await ctx.reply(en.mute.noSensorsToUnmute);
    } else {
      await ctx.reply(en.mute.unmutedAll(unmutedCount));
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('unmute', this.guard.registered, async (ctx: TelegramContext) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await this.handleEmpty(ctx);
        return;
      }
      if (target.toLowerCase() === 'all') {
        await this.handleUnmuteAll(ctx);
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

    composer.callbackQuery(/^unmute:/, this.guard.registered, async (ctx: TelegramContext) => {
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
