import { Injectable, Logger } from '@nestjs/common';
import { CallbackQueryContext, Composer, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import { SystemDepsCheckFailedError } from '../../system/domain/errors/system-deps-check-failed.error';
import { SystemDepsCheck } from '../../system/domain/ports/system-deps.port';
import { SystemUpdateUseCase } from '../application/system-update.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

/**
 * `/system_update` — spec 18. Admin-only, two-step flow mirroring
 * `/import_config`:
 *  1. Compute the installed-vs-available diff and show it.
 *  2. Apply/Cancel via inline keyboard; Apply spawns the detached
 *     `system-update.sh` script (snapshot → apt → rclone → node →
 *     health check → curl-on-failure).
 *
 * Per-user confirmation state is in-memory only (lost on restart) and only
 * ever holds entries for admins, since the command is admin-gated.
 */
@Injectable()
export class SystemUpdateHandler implements TelegramHandler {
  private readonly logger = new Logger(SystemUpdateHandler.name);
  private readonly pending = new Map<number, SystemDepsCheck>();

  constructor(
    private readonly systemUpdate: SystemUpdateUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('system_update', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
    composer.callbackQuery(/^sysupd:/, this.guard.adminOnly, (ctx) =>
      this.onCallback(ctx),
    );
  }

  cancelPending(userId: number): void {
    this.pending.delete(userId);
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.reply(en.systemUpdate.checking);

    let check: SystemDepsCheck;
    try {
      check = await this.systemUpdate.check();
    } catch (err) {
      this.pending.delete(userId);
      if (err instanceof SystemDepsCheckFailedError) {
        await ctx.reply(en.systemUpdate.checkFailed(err.reason));
        return;
      }
      this.logger.error(
        `/system_update check failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.systemUpdate.checkFailed((err as Error).message));
      return;
    }

    const body = check.deps.map((d) => en.systemUpdate.depLine(d)).join('\n');
    const warning = check.nodeMajorMismatch ? this.nodeWarning(check) : null;

    if (!check.hasUpdates) {
      this.pending.delete(userId);
      if (warning) {
        await ctx.reply(`${en.systemUpdate.header}\n\n${body}\n\n${warning}`);
        return;
      }
      await ctx.reply(en.systemUpdate.allUpToDate);
      return;
    }

    this.pending.set(userId, check);
    const lines = [en.systemUpdate.header, '', body];
    if (warning) lines.push('', warning);
    const keyboard = new InlineKeyboard()
      .text(en.systemUpdate.applyButton, 'sysupd:apply')
      .text(en.systemUpdate.cancelButton, 'sysupd:cancel');
    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  }

  private async onCallback(ctx: CallbackQueryContext<TelegramContext>): Promise<void> {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

    if (!userId) return;
    const pending = this.pending.get(userId);

    if (data === 'sysupd:cancel') {
      this.pending.delete(userId);
      await ctx.reply(en.systemUpdate.cancelled);
      return;
    }

    if (data === 'sysupd:apply') {
      if (!pending) {
        await ctx.reply(en.common.interrupted);
        return;
      }
      try {
        await this.systemUpdate.apply();
        this.pending.delete(userId);
        await ctx.reply(en.systemUpdate.applying);
      } catch (err) {
        this.pending.delete(userId);
        this.logger.error(
          `/system_update apply failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.systemUpdate.checkFailed((err as Error).message));
      }
    }
  }

  private nodeWarning(check: SystemDepsCheck): string | null {
    const node = check.deps.find((d) => d.name === 'node');
    if (node?.kind !== 'node-major') return null;
    const desired = (node.available ?? '').replace(/\.x$/, '');
    return en.systemUpdate.nodeMajorWarning(node.current ?? '?', desired || '?');
  }
}
