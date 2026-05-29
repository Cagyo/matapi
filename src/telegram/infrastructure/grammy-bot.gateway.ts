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
import { EventNotifierService } from '../../events/application/event-notifier.service';
import { EventProcessorService } from '../../events/application/event-processor.service';
import { RestartConfirmationService } from '../application/restart-confirmation.service';
import { ClaimAdminHandler } from '../interfaces/claim-admin.handler';
import { ConfigHandler } from '../interfaces/config.handler';
import { DemoteHandler } from '../interfaces/demote.handler';
import { HealthHandler } from '../interfaces/health.handler';
import { HelpHandler } from '../interfaces/help.handler';
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
import { TelegramHandler } from '../interfaces/telegram-handler';
import { UnmuteHandler } from '../interfaces/unmute.handler';
import { UpdateHandler } from '../interfaces/update.handler';
import { ConsoleNotifierAdapter } from './console-notifier.adapter';
import { TelegramDirectMessenger } from './telegram-direct-messenger.adapter';
import { TelegramNotifierAdapter } from './telegram-notifier.adapter';

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
export class GrammyBotGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GrammyBotGateway.name);
  private bot?: Bot;
  private runner?: RunnerHandle;
  private lastUpdateAt: Date | null = null;

  constructor(
    @Inject(BOT_MODE) private readonly mode: BotMode,
    private readonly eventNotifier: EventNotifierService,
    private readonly eventProcessor: EventProcessorService,
    private readonly telegramNotifier: TelegramNotifierAdapter,
    private readonly consoleNotifier: ConsoleNotifierAdapter,
    private readonly directMessenger: TelegramDirectMessenger,
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
    private readonly rollback: RollbackHandler,
    private readonly restart: RestartHandler,
    @Optional() private readonly token: string | undefined = process.env.TELEGRAM_BOT_TOKEN,
  ) {}

  /** Last update received from Telegram, or `null` if none yet (spec 08). */
  getLastUpdateAt(): Date | null {
    return this.lastUpdateAt;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode === 'mock' || !this.token) {
      this.logger.warn(
        this.mode === 'mock'
          ? 'BOT_MODE=mock — Telegram bot disabled, using console notifier'
          : 'TELEGRAM_BOT_TOKEN not set — Telegram bot disabled, using console notifier',
      );
      this.eventNotifier.register(this.consoleNotifier);
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

    this.bot = bot;
    this.runner = run(bot);
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
    if (this.runner?.isRunning()) {
      await this.runner.stop();
    }
    this.telegramNotifier.clearBot();
    this.directMessenger.clearBot();
    this.eventNotifier.clear();
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
      this.rollback,
      this.restart,
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
    ];
  }
}
