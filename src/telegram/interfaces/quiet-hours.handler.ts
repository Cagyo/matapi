import { Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import { SetQuietHoursUseCase } from '../application/set-quiet-hours.use-case';
import { InvalidQuietHoursError } from '../domain/errors/invalid-quiet-hours.error';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class QuietHoursHandler implements TelegramHandler {
  private readonly logger = new Logger(QuietHoursHandler.name);

  constructor(
    private readonly setQuietHours: SetQuietHoursUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  async handlePreset(ctx: TelegramContext, raw: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
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
        `handlePreset failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.quietHours.setFailed);
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command(
      'quiet_hours',
      this.guard.registered,
      async (ctx: TelegramContext) => {
        const userId = ctx.from?.id;
        if (!userId) return;
        const raw = (ctx.match ?? '').toString().trim();
        if (!raw) {
          const kb = new InlineKeyboard()
            .text(en.menu.submenus.quiet22_07, 'menu:act:quiet:22:00-07:00')
            .text(en.menu.submenus.quiet23_06, 'menu:act:quiet:23:00-06:00')
            .row()
            .text(en.menu.submenus.quiet00_08, 'menu:act:quiet:00:00-08:00')
            .text(en.menu.submenus.quietDisable, 'menu:act:quiet:off');
          await ctx.reply(en.menu.submenus.quietTitle, { reply_markup: kb });
          return;
        }
        await this.handlePreset(ctx, raw);
      },
    );
  }
}
