import { Injectable } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import { StatusHandler } from './status.handler';
import { HealthHandler } from './health.handler';
import { CameraHandler } from './camera.handler';
import { GdriveHandler } from './gdrive.handler';
import { InviteHandler } from './invite.handler';
import { ExportConfigHandler } from './export-config.handler';
import { LogsHandler } from './logs.handler';
import { MuteHandler } from './mute.handler';
import { UnmuteHandler } from './unmute.handler';
import { ConfigHandler } from './config.handler';
import { ImportConfigHandler } from './import-config.handler';
import { SystemUpdateHandler } from './system-update.handler';
import { RestartHandler } from './restart.handler';
import { QuietHoursHandler } from './quiet-hours.handler';
import { SettingsHandler } from './settings.handler';
import { CleanHandler } from './clean.handler';
import { GdriveAuthHandler } from './gdrive-auth.handler';
import { CsvHandler } from './csv.handler';
import { LEGACY_WORKFLOW_RETURN_CALLBACK } from './home-callback-ack.middleware';

@Injectable()
export class LegacyMenuHandler implements TelegramHandler {
  constructor(
    private readonly guard: RoleMiddleware,
    private readonly statusHandler: StatusHandler,
    private readonly healthHandler: HealthHandler,
    private readonly cameraHandler: CameraHandler,
    private readonly gdriveHandler: GdriveHandler,
    private readonly inviteHandler: InviteHandler,
    private readonly exportConfigHandler: ExportConfigHandler,
    private readonly logsHandler: LogsHandler,
    private readonly muteHandler: MuteHandler,
    private readonly unmuteHandler: UnmuteHandler,
    private readonly configHandler: ConfigHandler,
    private readonly importConfigHandler: ImportConfigHandler,
    private readonly systemUpdateHandler: SystemUpdateHandler,
    private readonly restartHandler: RestartHandler,
    private readonly quietHoursHandler: QuietHoursHandler,
    private readonly settingsHandler: SettingsHandler,
    private readonly cleanHandler: CleanHandler,
    private readonly gdriveAuthHandler: GdriveAuthHandler,
    private readonly csvHandler: CsvHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.callbackQuery(
      LEGACY_WORKFLOW_RETURN_CALLBACK,
      this.guard.registered,
      async (ctx) => {
        await this.acknowledgeOnce(ctx);
        const menu = this.catalog(ctx).commands.find((command) => command.command === 'menu');
        if (menu) await ctx.reply(menu.usage);
      },
    );
    composer.callbackQuery(
      /^legacy-menu:(.+)$/,
      this.guard.registered,
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const action = ctx.match?.[1];
        const role = ctx.localeState?.user.role;
        const catalog = this.catalog(ctx);

        if (!action) return;

        switch (action) {
          case 'top':
            await this.renderSubmenu(
              ctx,
              catalog.menu.title,
              this.buildKeyboard(catalog, role === 'admin'),
            );
            break;
          case 'status':
            await this.statusHandler.handleCommand(ctx);
            break;
          case 'sub:sensors': {
            const kb = new InlineKeyboard()
              .text(catalog.menu.submenus.sensorsMute, 'legacy-menu:act:mute')
              .text(catalog.menu.submenus.sensorsUnmute, 'legacy-menu:act:unmute')
              .row()
              .text(catalog.menu.submenus.sensorsMuteAll, 'legacy-menu:act:mute_all')
              .text(catalog.menu.submenus.sensorsUnmuteAll, 'legacy-menu:act:unmute_all')
              .row()
              .text(catalog.menu.submenus.sensorsExportCsv, 'legacy-menu:sub:csv')
              .row()
              .text(catalog.menu.submenus.backToMenu, 'legacy-menu:top');
            await this.renderSubmenu(ctx, catalog.menu.submenus.sensorsTitle, kb);
            break;
          }
          case 'sub:logs':
            await this.logsHandler.handleEmpty(ctx);
            break;
          case 'sub:csv':
            await this.csvHandler.handleEmpty(ctx, 'menu');
            break;
          case 'sub:camera':
            await this.cameraHandler.handleDashboard(ctx);
            break;
          case 'sub:quiet': {
            const kb = new InlineKeyboard()
              .text(catalog.menu.submenus.quiet22_07, 'legacy-menu:act:quiet:22:00-07:00')
              .text(catalog.menu.submenus.quiet23_06, 'legacy-menu:act:quiet:23:00-06:00')
              .row()
              .text(catalog.menu.submenus.quiet00_08, 'legacy-menu:act:quiet:00:00-08:00')
              .text(catalog.menu.submenus.quietDisable, 'legacy-menu:act:quiet:off')
              .row()
              .text(catalog.menu.submenus.backToMenu, 'legacy-menu:top');
            await this.renderSubmenu(ctx, catalog.menu.submenus.quietTitle, kb);
            break;
          }
          case 'sub:system': {
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            const kb = new InlineKeyboard()
              .text(catalog.menu.submenus.systemHealth, 'legacy-menu:health')
              .text(catalog.menu.submenus.systemDrive, 'legacy-menu:gdrive')
              .row()
              .text(catalog.menu.submenus.systemSettings, 'legacy-menu:settings')
              .text(catalog.menu.submenus.systemClean, 'legacy-menu:clean')
              .row()
              .text(catalog.menu.submenus.systemUpdate, 'legacy-menu:act:sys_update')
              .text(catalog.menu.submenus.systemRestart, 'legacy-menu:act:sys_restart')
              .row()
              .text(catalog.menu.submenus.systemInvite, 'legacy-menu:invite')
              .row()
              .text(catalog.gdriveAuth.button, 'legacy-menu:gdrive_auth')
              .row()
              .text(catalog.menu.submenus.backToMenu, 'legacy-menu:top');
            await this.renderSubmenu(ctx, catalog.menu.submenus.systemTitle, kb);
            break;
          }
          case 'sub:config': {
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            const kb = new InlineKeyboard()
              .text(catalog.menu.submenus.configAdd, 'legacy-menu:act:cfg_add')
              .text(catalog.menu.submenus.configModify, 'legacy-menu:act:cfg_mod')
              .row()
              .text(catalog.menu.submenus.configRemove, 'legacy-menu:act:cfg_rem')
              .text(catalog.menu.buttons.exportConfig, 'legacy-menu:export_config')
              .row()
              .text(catalog.importConfig.prompt, 'legacy-menu:act:cfg_imp')
              .row()
              .text(catalog.menu.submenus.backToMenu, 'legacy-menu:top');
            await this.renderSubmenu(ctx, catalog.menu.submenus.configTitle, kb);
            break;
          }
          case 'health':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.healthHandler.handleCommand(ctx);
            break;
          case 'gdrive':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.gdriveHandler.handleStatus(ctx);
            break;
          case 'gdrive_auth':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.gdriveAuthHandler.handleCommand(ctx);
            break;
          case 'settings':
            await this.settingsHandler.handleCommand(ctx);
            break;
          case 'clean':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.cleanHandler.handleCommand(ctx);
            break;
          case 'invite':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.inviteHandler.handleCommand(ctx);
            break;
          case 'export_config':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.exportConfigHandler.handleCommand(ctx);
            break;
          case 'act:mute':
            await this.muteHandler.handleEmpty(ctx);
            break;
          case 'act:unmute':
            await this.unmuteHandler.handleEmpty(ctx);
            break;
          case 'act:mute_all':
            await this.muteHandler.handleMuteAll(ctx);
            break;
          case 'act:unmute_all':
            await this.unmuteHandler.handleUnmuteAll(ctx);
            break;
          case 'act:cfg_add':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.configHandler.handleSubcommand(ctx, 'add');
            break;
          case 'act:cfg_mod':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.configHandler.handleSubcommand(ctx, 'modify');
            break;
          case 'act:cfg_rem':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.configHandler.handleSubcommand(ctx, 'remove');
            break;
          case 'act:cfg_imp':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.importConfigHandler.handleCommand(ctx);
            break;
          case 'act:sys_update':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.systemUpdateHandler.handleCommand(ctx);
            break;
          case 'act:sys_restart':
            if (role !== 'admin') {
              await ctx.reply(catalog.common.adminRequired);
              break;
            }
            await this.restartHandler.handleCommand(ctx);
            break;
          default:
            if (action.startsWith('act:quiet:')) {
              const preset = action.slice('act:quiet:'.length);
              await this.quietHoursHandler.handlePreset(ctx, preset);
            }
            break;
        }
      },
    );
  }

  private async renderSubmenu(
    ctx: TelegramContext,
    text: string,
    kb: InlineKeyboard,
  ): Promise<void> {
    try {
      await ctx.editMessageText(text, {
        reply_markup: kb,
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.reply(text, {
        reply_markup: kb,
        parse_mode: 'Markdown',
      });
    }
  }

  private buildKeyboard(catalog: LocaleCatalog, isAdmin: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text(catalog.menu.buttons.status, 'legacy-menu:status')
      .text(catalog.menu.categories.sensors, 'legacy-menu:sub:sensors')
      .text(catalog.menu.buttons.logs, 'legacy-menu:sub:logs')
      .row()
      .text(catalog.menu.categories.media, 'legacy-menu:sub:camera')
      .text(catalog.menu.buttons.exportCsv, 'legacy-menu:sub:csv')
      .row()
      .text(catalog.menu.buttons.settings, 'legacy-menu:settings');

    if (isAdmin) {
      keyboard
        .row()
        .text(catalog.menu.buttons.config, 'legacy-menu:sub:config')
        .text(catalog.menu.categories.lifecycle, 'legacy-menu:sub:system');
    }

    return keyboard;
  }

  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

  private async acknowledgeOnce(ctx: TelegramContext): Promise<void> {
    if (ctx.homeCallbackAcknowledged) return;
    await ctx.answerCallbackQuery().catch(() => undefined);
    ctx.homeCallbackAcknowledged = true;
  }
}
