import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { StatusHandler } from './status.handler';
import { HealthHandler } from './health.handler';
import { CameraHandler } from './camera.handler';
import { GdriveHandler } from './gdrive.handler';
import { InviteHandler } from './invite.handler';
import { ExportConfigHandler } from './export-config.handler';

@Injectable()
export class MenuHandler implements TelegramHandler {
  private readonly logger = new Logger(MenuHandler.name);

  constructor(
    private readonly guard: RoleMiddleware,
    private readonly statusHandler: StatusHandler,
    private readonly healthHandler: HealthHandler,
    private readonly cameraHandler: CameraHandler,
    private readonly gdriveHandler: GdriveHandler,
    private readonly inviteHandler: InviteHandler,
    private readonly exportConfigHandler: ExportConfigHandler,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('menu', this.guard.registered, async (ctx) => {
      const id = ctx.from?.id;
      const role = id ? await this.guard.resolveRole(id) : null;
      const keyboard = this.buildKeyboard(role === 'admin');
      await ctx.reply(en.menu.title, { reply_markup: keyboard });
    });

    composer.callbackQuery(
      /^menu:(.+)$/,
      this.guard.registered,
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const action = ctx.match?.[1];
        const id = ctx.from?.id;
        const role = id ? await this.guard.resolveRole(id) : null;

        if (!action) return;

        switch (action) {
          case 'status':
            await this.statusHandler.handleCommand(ctx);
            break;
          case 'health':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.healthHandler.handleCommand(ctx);
            break;
          case 'logs':
            await ctx.reply(en.menu.usage.logs);
            break;
          case 'mute':
            await ctx.reply(en.menu.usage.mute);
            break;
          case 'camera_status':
            await this.cameraHandler.handleStatus(ctx);
            break;
          case 'gdrive':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.gdriveHandler.handleStatus(ctx);
            break;
          case 'config':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await ctx.reply(en.menu.usage.config);
            break;
          case 'invite':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.inviteHandler.handleCommand(ctx);
            break;
          case 'feature':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await ctx.reply(en.menu.usage.feature);
            break;
          case 'update':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await ctx.reply(en.menu.usage.update);
            break;
          case 'restart':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await ctx.reply(en.menu.usage.restart);
            break;
          case 'export_config':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.exportConfigHandler.handleCommand(ctx);
            break;
          default:
            break;
        }
      },
    );
  }

  private buildKeyboard(isAdmin: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    // Category 1: Status & Sensors
    keyboard
      .text(en.menu.buttons.status, 'menu:status')
      .text(en.menu.buttons.logs, 'menu:logs')
      .text(en.menu.buttons.mute, 'menu:mute');
    if (isAdmin) {
      keyboard.text(en.menu.buttons.health, 'menu:health');
    }
    keyboard.row();

    // Category 2: Camera & Media
    keyboard.text(en.menu.buttons.cameraStatus, 'menu:camera_status');
    if (isAdmin) {
      keyboard.text(en.menu.buttons.gdrive, 'menu:gdrive');
    }
    keyboard.row();

    // Admin-only categories
    if (isAdmin) {
      // Category 3: Admin & Config
      keyboard
        .text(en.menu.buttons.config, 'menu:config')
        .text(en.menu.buttons.invite, 'menu:invite')
        .text(en.menu.buttons.feature, 'menu:feature')
        .row();

      // Category 4: Lifecycle & Maintenance
      keyboard
        .text(en.menu.buttons.update, 'menu:update')
        .text(en.menu.buttons.restart, 'menu:restart')
        .text(en.menu.buttons.exportConfig, 'menu:export_config');
    }

    return keyboard;
  }
}
