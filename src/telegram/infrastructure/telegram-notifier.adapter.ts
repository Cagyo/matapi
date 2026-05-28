import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, InputFile } from 'grammy';
import { AppDatabase, DB } from '../../database/database.module';
import { users } from '../../database/schema';
import {
  NotificationMessage,
  NotifierPort,
} from '../../events/domain/ports/notifier.port';

@Injectable()
export class TelegramNotifierAdapter implements NotifierPort {
  private readonly logger = new Logger(TelegramNotifierAdapter.name);
  private bot?: Bot;

  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  clearBot(): void {
    this.bot = undefined;
  }

  isReady(): boolean {
    return this.bot !== undefined;
  }

  async notify(message: NotificationMessage): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot is not ready');
    }

    const recipients = this.db.select({ id: users.telegramId }).from(users).all();
    const failures: Error[] = [];
    let delivered = 0;

    for (const recipient of recipients) {
      try {
        await this.sendToRecipient(recipient.id, message);
        delivered += 1;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        this.logger.warn(`Telegram notification failed: ${failure.message}`);
      }
    }

    if (recipients.length > 0 && delivered === 0 && failures.length > 0) {
      throw failures[0];
    }
  }

  private async sendToRecipient(
    recipientId: number,
    message: NotificationMessage,
  ): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot is not ready');
    }

    if (message.asFile) {
      await this.bot.api.sendDocument(
        recipientId,
        new InputFile(Buffer.from(message.text, 'utf8'), 'events.txt'),
      );
      return;
    }

    await this.bot.api.sendMessage(recipientId, message.text);
  }
}