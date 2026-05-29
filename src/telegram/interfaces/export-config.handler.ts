import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InputFile } from 'grammy';
import { en } from '../../locales/en';
import { ExportConfigUseCase } from '../application/export-config.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

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
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('export_config', this.guard.adminOnly, (ctx) =>
      this.onCommand(ctx),
    );
  }

  private async onCommand(ctx: Context): Promise<void> {
    try {
      const { yaml, filename } = await this.exportConfig.execute();
      const file = new InputFile(Buffer.from(yaml, 'utf8'), filename);
      await ctx.replyWithDocument(file, { caption: en.exportConfig.caption });
    } catch (error) {
      this.logger.error('export_config failed', error as Error);
      await ctx.reply(en.exportConfig.failed);
    }
  }
}
