import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Bot, GrammyError, HttpError } from 'grammy';
import { run, RunnerHandle } from '@grammyjs/runner';
import { autoRetry } from '@grammyjs/auto-retry';
import { DB, AppDatabase } from '../database/database.module';
import { users } from '../database/schema';
import { EventProcessor } from '../events/event.processor';
import { ClaimAdminCommand } from './commands/claim-admin.command';
import { StatusCommand } from './commands/status.command';
import { PingCommand } from './commands/ping.command';
import { HelpCommand } from './commands/help.command';

@Injectable()
export class BotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot?: Bot;
  private runner?: RunnerHandle;

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly eventProcessor: EventProcessor,
    private readonly claim: ClaimAdminCommand,
    private readonly status: StatusCommand,
    private readonly ping: PingCommand,
    private readonly help: HelpCommand,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled');
      return;
    }

    const bot = new Bot(token);
    bot.api.config.use(autoRetry());

    this.claim.register(bot);
    this.status.register(bot);
    this.ping.register(bot);
    this.help.register(bot);

    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        this.logger.error(`Telegram error: ${e.description}`);
      } else if (e instanceof HttpError) {
        this.logger.error(`Network error: ${e.message}`);
      } else {
        this.logger.error(`Bot error: ${(e as Error).message}`);
      }
    });

    this.eventProcessor.setSender(async (text: string) => {
      const recipients = this.db.select({ id: users.telegramId }).from(users).all();
      for (const r of recipients) {
        await bot.api.sendMessage(r.id, text);
      }
    });

    this.bot = bot;
    this.runner = run(bot);
    this.logger.log('Telegram bot started');

    // Drain anything pending from previous run.
    void this.eventProcessor.drain();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.runner?.isRunning()) {
      await this.runner.stop();
    }
  }
}
