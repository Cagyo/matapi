import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../../camera/domain/ports/media-repository.port';
import { en, TYPE_ICONS } from '../../locales/en';
import { MuteSensorUseCase } from '../application/mute-sensor.use-case';
import { SensorAlreadyMutedError } from '../domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext } from './telegram-context';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class MuteHandler implements TelegramHandler {
  private readonly logger = new Logger(MuteHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly mute: MuteSensorUseCase,
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
      kb.text(`${icon} ${s.name}`, `mute:${s.name}`).row();
    }
    for (const c of cameras) {
      const icon = TYPE_ICONS.camera ?? '📷';
      kb.text(`${icon} ${c.name}`, `mute:${c.name}`).row();
    }
    await ctx.reply(en.mute.selectMute, { reply_markup: kb });
  }

  async handleMuteAll(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const sensors = await this.sensors.listEnabled();
    const cameras = this.media
      ? (await this.media.listCameras()).filter((c) => c.enabled)
      : [];
    if (sensors.length === 0 && cameras.length === 0) {
      await ctx.reply(en.mute.noSensorsToMute);
      return;
    }
    let mutedCount = 0;
    for (const s of sensors) {
      try {
        await this.mute.execute(userId, s.name);
        mutedCount++;
      } catch (err) {
        if (!(err instanceof SensorAlreadyMutedError)) {
          this.logger.error(`Failed to mute ${s.name}: ${(err as Error).message}`);
        }
      }
    }
    for (const c of cameras) {
      try {
        await this.mute.execute(userId, c.name);
        mutedCount++;
      } catch (err) {
        if (!(err instanceof SensorAlreadyMutedError)) {
          this.logger.error(`Failed to mute ${c.name}: ${(err as Error).message}`);
        }
      }
    }
    if (mutedCount === 0) {
      await ctx.reply(en.mute.noSensorsToMute);
    } else {
      await ctx.reply(en.mute.mutedAll(mutedCount));
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('mute', this.guard.registered, async (ctx: TelegramContext) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const target = (ctx.match ?? '').toString().trim();
      if (!target) {
        await this.handleEmpty(ctx);
        return;
      }
      if (target.toLowerCase() === 'all') {
        await this.handleMuteAll(ctx);
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

    composer.callbackQuery(/^mute:/, this.guard.registered, async (ctx: TelegramContext) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
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
