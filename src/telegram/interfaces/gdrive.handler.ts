import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer } from 'grammy';
import { GdriveStatusUseCase } from '../../camera/application/gdrive-status.use-case';
import { GdriveNotConfiguredError } from '../../camera/domain/errors/gdrive-not-configured.error';
import { GdriveNotInstalledError } from '../../camera/domain/errors/gdrive-not-installed.error';
import { GdriveStatusFailedError } from '../../camera/domain/errors/gdrive-status-failed.error';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

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
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('gdrive', this.guard.adminOnly, async (ctx) => {
      const sub = (ctx.match ?? '').toString().trim().toLowerCase();
      if (sub && sub !== 'status') {
        await ctx.reply((ctx.localeState?.catalog ?? en).gdrive.usage);
        return;
      }
      await this.handleStatus(ctx);
    });
  }

  async handleStatus(
    ctx: TelegramContext,
    _options: { includeCleanupAction?: boolean } = {},
    launch?: WorkflowLaunch,
  ): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'drive-status', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const result = await this.status.execute();
      const body = catalog.gdrive.body({
        usedBytes: result.quota.usedBytes,
        totalBytes: result.quota.totalBytes,
        lastUploadAt: result.lastUploadAt,
        pendingUploads: result.pendingUploads,
        failedUploads: result.failedUploads,
        lastError: result.lastError,
        cleanupMinAgeDays: result.cleanupMinAgeDays,
      });
      await this.complete(ctx, receipt, () => ctx.reply(`${catalog.gdrive.header}\n\n${body}`));
    } catch (err) {
      await this.handleError(ctx, receipt, err);
    }
  }

  private async handleError(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    err: unknown,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (err instanceof GdriveNotInstalledError) {
      await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.notInstalled));
      return;
    }
    if (err instanceof GdriveNotConfiguredError) {
      await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.notConfigured));
      return;
    }
    if (err instanceof GdriveStatusFailedError) {
      await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.statusFailed(err.reason)));
      return;
    }
    this.logger.error(
      `/gdrive status failed: ${(err as Error).message}`,
      (err as Error).stack,
    );
    await this.complete(ctx, receipt, () => ctx.reply(catalog.common.error('/gdrive status', (err as Error).message)));
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await deliver(); },
        failureNotice: catalog.home.recovery.unavailable,
      });
      return;
    }
    await deliver();
  }
}
