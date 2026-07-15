import { Injectable } from '@nestjs/common';
import { Composer } from 'grammy';
import { CameraHandler } from './camera.handler';
import { ConfigHandler } from './config.handler';
import { GdriveAuthHandler } from './gdrive-auth.handler';
import { HomeLauncher } from './home-launcher';
import { ImportConfigHandler } from './import-config.handler';
import { RoleMiddleware } from './role.middleware';
import {
  ExternalWorkflow,
  parseReturnHomeCallback,
} from './return-home';
import { SystemUpdateHandler } from './system-update.handler';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

@Injectable()
export class ReturnHomeHandler implements TelegramHandler {
  constructor(
    private readonly launcher: HomeLauncher,
    private readonly guard: RoleMiddleware,
    private readonly config: ConfigHandler,
    private readonly configImport: ImportConfigHandler,
    private readonly drive: GdriveAuthHandler,
    private readonly systemUpdate: SystemUpdateHandler,
    private readonly camera: CameraHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.callbackQuery(/^rh:[lcsfidua]:[crt](?![\s\S])/, this.guard.registered, async (ctx) => {
      if (!ctx.homeCallbackAcknowledged) {
        await ctx.answerCallbackQuery().catch(() => undefined);
      }
      const action = parseReturnHomeCallback(ctx.callbackQuery?.data ?? '');
      if (!action) return;

      const userId = ctx.from?.id;
      const chatId = ctx.chat?.type === 'private' ? ctx.chat.id : undefined;
      if (action.phase === 'cancelPending' && userId !== undefined) {
        this.cancelPending(action.workflow, userId, chatId);
      }
      await this.launcher.launch(ctx);
    });
  }

  private cancelPending(
    workflow: ExternalWorkflow,
    userId: number,
    chatId: number | undefined,
  ): void {
    switch (workflow) {
      case 'config':
        this.config.cancelPending(userId);
        return;
      case 'configImport':
        this.configImport.cancelPending(userId);
        return;
      case 'drive':
        this.drive.cancelPending(userId);
        return;
      case 'systemUpdate':
        this.systemUpdate.cancelPending(userId);
        return;
      case 'camera':
        if (chatId !== undefined) this.camera.cancelPending(userId, chatId);
        return;
      case 'logs':
      case 'csv':
      case 'settings':
        return;
    }
  }
}
