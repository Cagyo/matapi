import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { autoRetry } from '@grammyjs/auto-retry';
import { run, RunnerHandle } from '@grammyjs/runner';
import { Bot, GrammyError, HttpError } from 'grammy';
import { AdminAlertService } from '../../camera/application/admin-alert.service';
import { EventNotifierService } from '../../events/application/event-notifier.service';
import { EventProcessorService } from '../../events/application/event-processor.service';
import { RecipientDirectoryService } from '../../events/application/recipient-directory.service';
import { BotRunnerRegistry } from '../../network/application/bot-runner.registry';
import { BotRunnerPort } from '../../network/domain/ports/bot-runner.port';
import { RestartConfirmationService } from '../application/restart-confirmation.service';
import { ClaimAdminHandler } from '../interfaces/claim-admin.handler';
import { CameraHandler } from '../interfaces/camera.handler';
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
import { ConsoleNotifierAdapter } from './console-notifier.adapter';
import { TelegramAdminAlertAdapter } from './telegram-admin-alert.adapter';
import { TelegramDirectMessenger } from './telegram-direct-messenger.adapter';
import { TelegramNotifierAdapter } from './telegram-notifier.adapter';
import { TelegramRecipientDirectoryAdapter } from './telegram-recipient-directory.adapter';

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
  private bot?: Bot;
  private runner?: RunnerHandle;
  private lastUpdateAt: Date | null = null;

  constructor(
    @Inject(BOT_MODE) private readonly mode: BotMode,
    private readonly botRunnerRegistry: BotRunnerRegistry,
    private readonly eventNotifier: EventNotifierService,
    private readonly eventProcessor: EventProcessorService,
    private readonly recipientDirectory: RecipientDirectoryService,
    private readonly telegramNotifier: TelegramNotifierAdapter,
    private readonly telegramRecipients: TelegramRecipientDirectoryAdapter,
    private readonly consoleNotifier: ConsoleNotifierAdapter,
    private readonly directMessenger: TelegramDirectMessenger,
    private readonly adminAlertService: AdminAlertService,
    private readonly telegramAdminAlert: TelegramAdminAlertAdapter,
    private readonly restartConfirmation: RestartConfirmationService,
    private readonly claim: ClaimAdminHandler,
    private readonly status: StatusHandler,
    private readonly ping: PingHandler,
    private readonly help: HelpHandler,
    private readonly logs: LogsHandler,
    private readonly health: HealthHandler,
    private readonly config: ConfigHandler,
    private readonly invite: InviteHandler,
    private readonly start: StartHandler,
    private readonly promote: PromoteHandler,
    private readonly demote: DemoteHandler,
    private readonly mute: MuteHandler,
    private readonly unmute: UnmuteHandler,
    private readonly quietHours: QuietHoursHandler,
    private readonly update: UpdateHandler,
    private readonly systemUpdate: SystemUpdateHandler,
    private readonly rollback: RollbackHandler,
    private readonly restartHandler: RestartHandler,
    private readonly camera: CameraHandler,
    private readonly gdrive: GdriveHandler,
    private readonly exportConfig: ExportConfigHandler,
    private readonly importConfig: ImportConfigHandler,
    private readonly feature: FeatureHandler,
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
    this.runner = run(this.bot);
    this.logger.warn('grammY runner force-restarted');
  }

  async onApplicationBootstrap(): Promise<void> {
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

    const bot = new Bot(this.token);

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
    this.eventNotifier.register(this.telegramNotifier);
    this.recipientDirectory.register(this.telegramRecipients);
    this.adminAlertService.register(this.telegramAdminAlert);

    this.bot = bot;
    this.runner = run(bot);
    this.botRunnerRegistry.register(this);
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
    this.eventNotifier.clear();
    this.recipientDirectory.clear();
    this.adminAlertService.clear();
    this.bot = undefined;
    this.runner = undefined;
  }

  private handlers(): TelegramHandler[] {
    return [
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
    ];
  }
}
