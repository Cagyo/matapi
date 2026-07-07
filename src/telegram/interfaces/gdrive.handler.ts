import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InlineKeyboard } from 'grammy';
import { GdriveStatusUseCase } from '../../camera/application/gdrive-status.use-case';
import { GdriveNotConfiguredError } from '../../camera/domain/errors/gdrive-not-configured.error';
import { GdriveNotInstalledError } from '../../camera/domain/errors/gdrive-not-installed.error';
import { GdriveStatusFailedError } from '../../camera/domain/errors/gdrive-status-failed.error';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

/**
 * `/gdrive status` — spec 15. Admin-only. Reports Drive quota, pending and
 * failed uploads, last upload time, and auto-cleanup configuration.
 */
@Injectable()
export class GdriveHandler implements TelegramHandler {
  private readonly logger = new Logger(GdriveHandler.name);

  constructor(
    private readonly status: GdriveStatusUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('gdrive', this.guard.adminOnly, async (ctx) => {
      const sub = (ctx.match ?? '').toString().trim().toLowerCase();
      if (sub && sub !== 'status') {
        await ctx.reply(en.gdrive.usage);
        return;
      }
      await this.handleStatus(ctx);
    });
  }

  async handleStatus(ctx: Context): Promise<void> {
    try {
      const result = await this.status.execute();
      const body = en.gdrive.body({
        usedBytes: result.quota.usedBytes,
        totalBytes: result.quota.totalBytes,
        lastUploadAt: result.lastUploadAt,
        pendingUploads: result.pendingUploads,
        failedUploads: result.failedUploads,
        lastError: result.lastError,
        cleanupMinAgeDays: result.cleanupMinAgeDays,
      });
      const kb = new InlineKeyboard()
        .text(en.gdrive.cleanButton, 'clean:trigger')
        .text(en.gdriveAuth.button, 'gdauth:start');
      await ctx.reply(`${en.gdrive.header}\n\n${body}`, { reply_markup: kb });
    } catch (err) {
      await this.handleError(ctx, err);
    }
  }

  private async handleError(ctx: Context, err: unknown): Promise<void> {
    if (err instanceof GdriveNotInstalledError) {
      await ctx.reply(en.gdrive.notInstalled);
      return;
    }
    if (err instanceof GdriveNotConfiguredError) {
      await ctx.reply(en.gdrive.notConfigured);
      return;
    }
    if (err instanceof GdriveStatusFailedError) {
      await ctx.reply(en.gdrive.statusFailed(err.reason));
      return;
    }
    this.logger.error(
      `/gdrive status failed: ${(err as Error).message}`,
      (err as Error).stack,
    );
    await ctx.reply(en.common.error('/gdrive status', (err as Error).message));
  }
}
