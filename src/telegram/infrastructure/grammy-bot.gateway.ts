import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { autoRetry } from '@grammyjs/auto-retry';
import { run, RunnerHandle, sequentialize } from '@grammyjs/runner';
import { Bot, GrammyError, HttpError } from 'grammy';
import { AdminAlertService } from '../../camera/application/admin-alert.service';
import { LiveStreamMessageCleanupService } from '../../camera/application/live-stream-message-cleanup.service';
import { EventNotifierService } from '../../events/application/event-notifier.service';
import { EventProcessorService } from '../../events/application/event-processor.service';
import { RecipientDirectoryService } from '../../events/application/recipient-directory.service';
import { BotRunnerRegistry } from '../../network/application/bot-runner.registry';
import { BotRunnerPort } from '../../network/domain/ports/bot-runner.port';
import { RestartConfirmationService } from '../interfaces/restart-confirmation.service';
import { SystemOnlineNotifier } from '../application/system-online-notifier.service';
import { ClaimAdminHandler } from '../interfaces/claim-admin.handler';
import { CameraHandler } from '../interfaces/camera.handler';
import { CsvHandler } from '../interfaces/csv.handler';
import { ConfigHandler } from '../interfaces/config.handler';
import { DemoteHandler } from '../interfaces/demote.handler';
import { ExportConfigHandler } from '../interfaces/export-config.handler';
import { FeatureHandler } from '../interfaces/feature.handler';
import { GdriveHandler } from '../interfaces/gdrive.handler';
import { HealthHandler } from '../interfaces/health.handler';
import { HelpHandler } from '../interfaces/help.handler';
import { ImportConfigHandler } from '../interfaces/import-config.handler';
import { InviteHandler } from '../interfaces/invite.handler';
import { LogsHandler } from '../interfaces/logs.handler';
import { MuteHandler } from '../interfaces/mute.handler';
import { PingHandler } from '../interfaces/ping.handler';
import { PromoteHandler } from '../interfaces/promote.handler';
import { QuietHoursHandler } from '../interfaces/quiet-hours.handler';
import { RestartHandler } from '../interfaces/restart.handler';
import { RollbackHandler } from '../interfaces/rollback.handler';
import { StartHandler } from '../interfaces/start.handler';
import { StatusHandler } from '../interfaces/status.handler';
import { SystemUpdateHandler } from '../interfaces/system-update.handler';
import { TelegramHandler } from '../interfaces/telegram-handler';
import { UnmuteHandler } from '../interfaces/unmute.handler';
import { UpdateHandler } from '../interfaces/update.handler';
import { HomeHandler } from '../interfaces/home.handler';
import { LegacyMenuHandler } from '../interfaces/legacy-menu.handler';
import { SettingsHandler } from '../interfaces/settings.handler';
import { CleanHandler } from '../interfaces/clean.handler';
import { WorkflowNavigationHandler } from '../interfaces/workflow-navigation.handler';
import { GdriveAuthHandler } from '../interfaces/gdrive-auth.handler';
import { LocaleMiddleware } from '../interfaces/locale.middleware';
import { homeCallbackAckMiddleware } from '../interfaces/home-callback-ack.middleware';
import { TelegramContext } from '../interfaces/telegram-context';
import { homeUpdateConstraints } from '../interfaces/home-update-constraints';
import { BotCommandsMenuService } from '../application/bot-commands-menu.service';
import {
  HOME_MESSAGE_DELIVERY,
  type HomeMessageDeliveryPort,
} from '../application/ports/home-message-delivery.port';
import { ConsoleNotifierAdapter } from './console-notifier.adapter';
import { TelegramAdminAlertAdapter } from './telegram-admin-alert.adapter';
import { TelegramLiveStreamMessageCleanupAdapter } from './telegram-live-stream-message-cleanup.adapter';
import { TelegramDirectMessenger } from './telegram-direct-messenger.adapter';
import { TelegramNotifierAdapter } from './telegram-notifier.adapter';
import { TelegramRecipientDirectoryAdapter } from './telegram-recipient-directory.adapter';
import { TelegramHomeMessageAdapter } from './telegram-home-message.adapter';

/** Token for the env-resolved bot mode. */
export const BOT_MODE = Symbol('BOT_MODE');
export type BotMode = 'real' | 'mock';

/**
 * Single composition gateway for the grammY bot — spec 06.
 *
 * - Polling has a 30s timeout (per spec).
 * - `autoRetry` covers Telegram rate limits / inter-batch pacing.
 * - Only private-chat updates are processed (spec 06 → Chat Architecture).
 * - In `mock` mode no Bot is constructed; a `ConsoleNotifierAdapter` is
 *   bound instead so the event pipeline drains locally without a token.
 */
@Injectable()
export class GrammyBotGateway
  implements OnApplicationBootstrap, OnModuleDestroy, BotRunnerPort
{
  private readonly logger = new Logger(GrammyBotGateway.name);
  private bot?: Bot<TelegramContext>;
  private runner?: RunnerHandle;
  private lastUpdateAt: Date | null = null;

  constructor(
    @Inject(BOT_MODE) private readonly mode: BotMode,
    @Inject(forwardRef(() => BotRunnerRegistry))
    private readonly botRunnerRegistry: BotRunnerRegistry,
    @Inject(forwardRef(() => EventNotifierService))
    private readonly eventNotifier: EventNotifierService,
    @Inject(forwardRef(() => EventProcessorService))
    private readonly eventProcessor: EventProcessorService,
    @Inject(forwardRef(() => RecipientDirectoryService))
    private readonly recipientDirectory: RecipientDirectoryService,
    @Inject(forwardRef(() => TelegramNotifierAdapter))
    private readonly telegramNotifier: TelegramNotifierAdapter,
    @Inject(forwardRef(() => TelegramRecipientDirectoryAdapter))
    private readonly telegramRecipients: TelegramRecipientDirectoryAdapter,
    @Inject(forwardRef(() => ConsoleNotifierAdapter))
    private readonly consoleNotifier: ConsoleNotifierAdapter,
    @Inject(forwardRef(() => TelegramDirectMessenger))
    private readonly directMessenger: TelegramDirectMessenger,
    @Inject(HOME_MESSAGE_DELIVERY)
    private readonly homeMessageDelivery: HomeMessageDeliveryPort,
    @Inject(forwardRef(() => AdminAlertService))
    private readonly adminAlertService: AdminAlertService,
    @Inject(forwardRef(() => TelegramAdminAlertAdapter))
    private readonly telegramAdminAlert: TelegramAdminAlertAdapter,
    @Inject(forwardRef(() => LiveStreamMessageCleanupService))
    private readonly liveStreamMessageCleanup: LiveStreamMessageCleanupService,
    @Inject(forwardRef(() => TelegramLiveStreamMessageCleanupAdapter))
    private readonly telegramLiveStreamMessageCleanup: TelegramLiveStreamMessageCleanupAdapter,
    @Inject(forwardRef(() => RestartConfirmationService))
    private readonly restartConfirmation: RestartConfirmationService,
    @Inject(forwardRef(() => SystemOnlineNotifier))
    private readonly systemOnline: SystemOnlineNotifier,
    @Inject(forwardRef(() => ClaimAdminHandler))
    private readonly claim: ClaimAdminHandler,
    @Inject(forwardRef(() => StatusHandler))
    private readonly status: StatusHandler,
    @Inject(forwardRef(() => PingHandler))
    private readonly ping: PingHandler,
    @Inject(forwardRef(() => HelpHandler))
    private readonly help: HelpHandler,
    @Inject(forwardRef(() => LogsHandler))
    private readonly logs: LogsHandler,
    @Inject(forwardRef(() => HealthHandler))
    private readonly health: HealthHandler,
    @Inject(forwardRef(() => ConfigHandler))
    private readonly config: ConfigHandler,
    @Inject(forwardRef(() => InviteHandler))
    private readonly invite: InviteHandler,
    @Inject(forwardRef(() => StartHandler))
    private readonly start: StartHandler,
    @Inject(forwardRef(() => PromoteHandler))
    private readonly promote: PromoteHandler,
    @Inject(forwardRef(() => DemoteHandler))
    private readonly demote: DemoteHandler,
    @Inject(forwardRef(() => MuteHandler))
    private readonly mute: MuteHandler,
    @Inject(forwardRef(() => UnmuteHandler))
    private readonly unmute: UnmuteHandler,
    @Inject(forwardRef(() => QuietHoursHandler))
    private readonly quietHours: QuietHoursHandler,
    @Inject(forwardRef(() => UpdateHandler))
    private readonly update: UpdateHandler,
    @Inject(forwardRef(() => SystemUpdateHandler))
    private readonly systemUpdate: SystemUpdateHandler,
    @Inject(forwardRef(() => RollbackHandler))
    private readonly rollback: RollbackHandler,
    @Inject(forwardRef(() => RestartHandler))
    private readonly restartHandler: RestartHandler,
    @Inject(forwardRef(() => CameraHandler))
    private readonly camera: CameraHandler,
    @Inject(forwardRef(() => GdriveHandler))
    private readonly gdrive: GdriveHandler,
    @Inject(forwardRef(() => ExportConfigHandler))
    private readonly exportConfig: ExportConfigHandler,
    @Inject(forwardRef(() => ImportConfigHandler))
    private readonly importConfig: ImportConfigHandler,
    @Inject(forwardRef(() => FeatureHandler))
    private readonly feature: FeatureHandler,
    @Inject(forwardRef(() => GdriveAuthHandler))
    private readonly gdriveAuth: GdriveAuthHandler,
    @Inject(forwardRef(() => CsvHandler))
    private readonly csv: CsvHandler,
    @Inject(forwardRef(() => HomeHandler))
    private readonly home: HomeHandler,
    @Inject(forwardRef(() => WorkflowNavigationHandler))
    private readonly workflowNavigation: WorkflowNavigationHandler,
    @Inject(forwardRef(() => LegacyMenuHandler))
    private readonly legacyMenu: LegacyMenuHandler,
    @Inject(forwardRef(() => SettingsHandler))
    private readonly settings: SettingsHandler,
    @Inject(forwardRef(() => CleanHandler))
    private readonly clean: CleanHandler,
    @Inject(forwardRef(() => BotCommandsMenuService))
    private readonly botCommandsMenu: BotCommandsMenuService,
    private readonly localeMiddleware: LocaleMiddleware,
    @Optional() private readonly token: string | undefined = process.env.TELEGRAM_BOT_TOKEN,
  ) {}

  /** Last update received from Telegram, or `null` if none yet (spec 08, 22). */
  getLastUpdateAt(): Date | null {
    return this.lastUpdateAt;
  }

  /** Whether the grammY runner is currently polling (spec 22). */
  isRunning(): boolean {
    return this.runner?.isRunning() ?? false;
  }

  /**
   * Force-restart the grammY runner (spec 22 → Bot Polling Recovery). Recovers
   * a half-open polling socket that grammY still believes is alive.
   */
  async restart(): Promise<void> {
    if (!this.bot) return;
    if (this.runner?.isRunning()) await this.runner.stop();
    const replacement = run(this.bot);
    this.runner = replacement;
    this.lastUpdateAt = null;
    this.logger.warn('grammY runner force-restarted');
  }

  async onApplicationBootstrap(): Promise<void> {
    this.liveStreamMessageCleanup.register(this.telegramLiveStreamMessageCleanup);
    if (this.mode === 'mock' || !this.token) {
      this.logger.warn(
        this.mode === 'mock'
          ? 'BOT_MODE=mock — Telegram bot disabled, using console notifier'
          : 'TELEGRAM_BOT_TOKEN not set — Telegram bot disabled, using console notifier',
      );
      this.eventNotifier.register(this.consoleNotifier);
      this.recipientDirectory.register(this.telegramRecipients);
      this.adminAlertService.register(this.telegramAdminAlert);
      void this.eventProcessor.drain();
      return;
    }

    const bot = new Bot<TelegramContext>(this.token);

    // 30s timeout on polling (spec 06 → Polling Health) — prevents
    // half-open TCP sockets on network drops.
    bot.api.config.use((prev, method, payload, signal) =>
      prev(method, { timeoutSeconds: 30, ...payload }, signal),
    );
    bot.api.config.use(autoRetry());

    // Private-chat-only filter (spec 06 → Chat Architecture). Updates from
    // group chats or channels are silently dropped before any handler runs.
    bot.use(async (ctx, next) => {
      if (ctx.chat?.type === 'private') return next();
    });

    // Track last-update timestamp for `/health` (spec 08). Captured before
    // the handler chain so even ignored updates count as "bot is alive".
    bot.use(async (_ctx, next) => {
      this.lastUpdateAt = new Date();
      return next();
    });

    bot.use(homeCallbackAckMiddleware);
    bot.use(sequentialize(homeUpdateConstraints));

    // Must run before guards and handlers: registered paths receive their
    // persisted locale, while `/start` and `/claim_admin` continue in English.
    bot.use(this.localeMiddleware.resolveOptional);

    for (const handler of this.handlers()) {
      handler.register(bot);
    }

    bot.catch((err) => {
      const cause = err.error;
      if (cause instanceof GrammyError) {
        this.logger.error(`Telegram error: ${cause.description}`);
      } else if (cause instanceof HttpError) {
        this.logger.error(`Network error: ${cause.message}`);
      } else {
        this.logger.error(`Bot error: ${(cause as Error).message}`);
      }
    });

    this.telegramNotifier.setBot(bot);
    this.directMessenger.setBot(bot);
    if (this.homeMessageDelivery instanceof TelegramHomeMessageAdapter) {
      this.homeMessageDelivery.setBot(bot);
    }
    this.botCommandsMenu.setBot(bot);
    this.telegramLiveStreamMessageCleanup.setBot(bot);
    this.eventNotifier.register(this.telegramNotifier);
    this.recipientDirectory.register(this.telegramRecipients);
    this.adminAlertService.register(this.telegramAdminAlert);

    this.bot = bot;
    this.runner = run(bot);
    this.botRunnerRegistry.register(this);
    void this.botCommandsMenu.syncAllUsers();
    this.logger.log('Telegram bot started');

    // Report the outcome of the previous restart (user /restart, OTA
    // update, rollback) to admins, then clear the flag.
    void this.restartConfirmation
      .run()
      .catch((err) =>
        this.logger.warn(
          `restart confirmation failed: ${(err as Error).message}`,
        ),
      );

    // Broadcast that the worker is back online, surfacing any DB recovery or
    // clock-drift warning from boot recovery (spec 23).
    void this.systemOnline
      .run()
      .catch((err) =>
        this.logger.warn(`system online notice failed: ${(err as Error).message}`),
      );

    // Drain anything pending from a previous run.
    void this.eventProcessor.drain();
  }

  async onModuleDestroy(): Promise<void> {
    this.botRunnerRegistry.clear();
    if (this.runner?.isRunning()) {
      await this.runner.stop();
    }
    this.telegramNotifier.clearBot();
    this.directMessenger.clearBot();
    if (this.homeMessageDelivery instanceof TelegramHomeMessageAdapter) {
      this.homeMessageDelivery.clearBot();
    }
    this.botCommandsMenu.clearBot();
    this.telegramLiveStreamMessageCleanup.clearBot();
    this.eventNotifier.clear();
    this.recipientDirectory.clear();
    this.adminAlertService.clear();
    this.liveStreamMessageCleanup.clear();
    this.bot = undefined;
    this.runner = undefined;
  }

  private handlers(): TelegramHandler[] {
    return [
      // Receipt-bound workflow returns must win before every broad workflow
      // callback handler can inspect the update.
      this.workflowNavigation,
      this.claim,
      this.mute,
      this.unmute,
      this.quietHours,
      this.update,
      this.systemUpdate,
      this.rollback,
      this.restartHandler,
      this.start,
      this.status,
      this.ping,
      this.help,
      this.logs,
      this.health,
      this.config,
      this.invite,
      this.promote,
      this.demote,
      this.camera,
      this.gdrive,
      this.exportConfig,
      this.importConfig,
      this.feature,
      this.gdriveAuth,
      this.csv,
      this.home,
      this.legacyMenu,
      this.settings,
      this.clean,
    ];
  }
}
