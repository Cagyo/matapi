import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
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
    @Inject(forwardRef(() => LogsHandler))
    private readonly logsHandler: LogsHandler,
    @Inject(forwardRef(() => MuteHandler))
    private readonly muteHandler: MuteHandler,
    @Inject(forwardRef(() => UnmuteHandler))
    private readonly unmuteHandler: UnmuteHandler,
    @Inject(forwardRef(() => ConfigHandler))
    private readonly configHandler: ConfigHandler,
    @Inject(forwardRef(() => ImportConfigHandler))
    private readonly importConfigHandler: ImportConfigHandler,
    @Inject(forwardRef(() => SystemUpdateHandler))
    private readonly systemUpdateHandler: SystemUpdateHandler,
    @Inject(forwardRef(() => RestartHandler))
    private readonly restartHandler: RestartHandler,
    @Inject(forwardRef(() => QuietHoursHandler))
    private readonly quietHoursHandler: QuietHoursHandler,
    @Inject(forwardRef(() => SettingsHandler))
    private readonly settingsHandler: SettingsHandler,
    @Inject(forwardRef(() => CleanHandler))
    private readonly cleanHandler: CleanHandler,
    @Inject(forwardRef(() => GdriveAuthHandler))
    private readonly gdriveAuthHandler: GdriveAuthHandler,
    @Inject(forwardRef(() => CsvHandler))
    private readonly csvHandler: CsvHandler,
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
          case 'top':
            await this.renderSubmenu(
              ctx,
              en.menu.title,
              this.buildKeyboard(role === 'admin'),
            );
            break;
          case 'status':
            await this.statusHandler.handleCommand(ctx);
            break;
          case 'sub:sensors': {
            const kb = new InlineKeyboard()
              .text(en.menu.submenus.sensorsMute, 'menu:act:mute')
              .text(en.menu.submenus.sensorsUnmute, 'menu:act:unmute')
              .row()
              .text(en.menu.submenus.sensorsMuteAll, 'menu:act:mute_all')
              .text(en.menu.submenus.sensorsUnmuteAll, 'menu:act:unmute_all')
              .row()
              .text(en.menu.submenus.sensorsExportCsv, 'menu:sub:csv')
              .row()
              .text(en.menu.submenus.backToMenu, 'menu:top');
            await this.renderSubmenu(ctx, en.menu.submenus.sensorsTitle, kb);
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
              .text(en.menu.submenus.quiet22_07, 'menu:act:quiet:22:00-07:00')
              .text(en.menu.submenus.quiet23_06, 'menu:act:quiet:23:00-06:00')
              .row()
              .text(en.menu.submenus.quiet00_08, 'menu:act:quiet:00:00-08:00')
              .text(en.menu.submenus.quietDisable, 'menu:act:quiet:off')
              .row()
              .text(en.menu.submenus.backToMenu, 'menu:top');
            await this.renderSubmenu(ctx, en.menu.submenus.quietTitle, kb);
            break;
          }
          case 'sub:system': {
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            const kb = new InlineKeyboard()
              .text(en.menu.submenus.systemHealth, 'menu:health')
              .text(en.menu.submenus.systemDrive, 'menu:gdrive')
              .row()
              .text(en.menu.submenus.systemSettings, 'menu:settings')
              .text(en.menu.submenus.systemClean, 'menu:clean')
              .row()
              .text(en.menu.submenus.systemUpdate, 'menu:act:sys_update')
              .text(en.menu.submenus.systemRestart, 'menu:act:sys_restart')
              .row()
              .text(en.menu.submenus.systemInvite, 'menu:invite')
              .row()
              .text(en.gdriveAuth.button, 'menu:gdrive_auth')
              .row()
              .text(en.menu.submenus.backToMenu, 'menu:top');
            await this.renderSubmenu(ctx, en.menu.submenus.systemTitle, kb);
            break;
          }
          case 'sub:config': {
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            const kb = new InlineKeyboard()
              .text(en.menu.submenus.configAdd, 'menu:act:cfg_add')
              .text(en.menu.submenus.configModify, 'menu:act:cfg_mod')
              .row()
              .text(en.menu.submenus.configRemove, 'menu:act:cfg_rem')
              .text(en.menu.buttons.exportConfig, 'menu:export_config')
              .row()
              .text('📥 Import Config', 'menu:act:cfg_imp')
              .row()
              .text(en.menu.submenus.backToMenu, 'menu:top');
            await this.renderSubmenu(ctx, en.menu.submenus.configTitle, kb);
            break;
          }
          case 'health':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.healthHandler.handleCommand(ctx);
            break;
          case 'gdrive':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.gdriveHandler.handleStatus(ctx);
            break;
          case 'gdrive_auth':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.gdriveAuthHandler.handleCommand(ctx);
            break;
          case 'settings':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.settingsHandler.handleCommand(ctx);
            break;
          case 'clean':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.cleanHandler.handleCommand(ctx);
            break;
          case 'invite':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.inviteHandler.handleCommand(ctx);
            break;
          case 'export_config':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
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
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.configHandler.handleSubcommand(ctx, 'add');
            break;
          case 'act:cfg_mod':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.configHandler.handleSubcommand(ctx, 'modify');
            break;
          case 'act:cfg_rem':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.configHandler.handleSubcommand(ctx, 'remove');
            break;
          case 'act:cfg_imp':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.importConfigHandler.handleCommand(ctx);
            break;
          case 'act:sys_update':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
              break;
            }
            await this.systemUpdateHandler.handleCommand(ctx);
            break;
          case 'act:sys_restart':
            if (role !== 'admin') {
              await ctx.reply(en.common.adminRequired);
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
    ctx: Context,
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

  private buildKeyboard(isAdmin: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text('📊 Status', 'menu:status')
      .text('🎛️ Sensors', 'menu:sub:sensors')
      .text('📋 Logs', 'menu:sub:logs')
      .row()
      .text('📷 Camera', 'menu:sub:camera')
      .text('🌙 Quiet Mode', 'menu:sub:quiet')
      .text(en.menu.buttons.exportCsv, 'menu:sub:csv');

    if (isAdmin) {
      keyboard
        .row()
        .text('⚙️ Config', 'menu:sub:config')
        .text('🔄 System', 'menu:sub:system');
    }

    return keyboard;
  }
}
