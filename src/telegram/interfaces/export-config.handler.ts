import { Injectable, Logger } from '@nestjs/common';
import { Composer, InputFile } from 'grammy';
import { en } from '../../locales/en';
import { ExportConfigUseCase } from '../application/export-config.use-case';
import { RoleMiddleware } from './role.middleware';
import { returnHomeKeyboard } from './return-home';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

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

  register(composer: Composer<TelegramContext>): void {
    composer.command('export_config', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    try {
      const { yaml, filename } = await this.exportConfig.execute();
      const file = new InputFile(Buffer.from(yaml, 'utf8'), filename);
      const catalog = ctx.localeState?.catalog ?? en;
      await ctx.replyWithDocument(file, {
        caption: en.exportConfig.caption,
        reply_markup: returnHomeKeyboard(catalog, {
          workflow: 'config',
          phase: 'alreadyTerminal',
        }),
      });
    } catch (error) {
      this.logger.error('export_config failed', error as Error);
      const catalog = ctx.localeState?.catalog ?? en;
      await ctx.reply(en.exportConfig.failed, {
        reply_markup: returnHomeKeyboard(catalog, {
          workflow: 'config',
          phase: 'alreadyTerminal',
        }),
      });
    }
  }
}
