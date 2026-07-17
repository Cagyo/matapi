import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InputFile } from 'grammy';
import { en } from '../../locales/en';
import { ExportConfigUseCase } from '../application/export-config.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

/**
 * `/export_config` — spec 16. Admin-only. Snapshots the current sensors,
 * cameras, and feature flags into a YAML document and replies with it as a
 * downloadable file.
 */
@Injectable()
export class ExportConfigHandler implements TelegramHandler {
  private readonly logger = new Logger(ExportConfigHandler.name);

  constructor(
    private readonly exportConfig: ExportConfigUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('export_config', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'sensor-export', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const { yaml, filename } = await this.exportConfig.execute();
      const file = new InputFile(Buffer.from(yaml, 'utf8'), filename);
      await this.complete(ctx, receipt, () => ctx.replyWithDocument(file, {
        caption: catalog.exportConfig.caption,
      }));
    } catch (error) {
      this.logger.error('export_config failed', error as Error);
      await this.complete(ctx, receipt, () => ctx.reply(catalog.exportConfig.failed));
    }
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
