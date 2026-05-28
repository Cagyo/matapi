import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, InputFile } from 'grammy';
import {
  NotificationMessage,
  NotifierPort,
} from '../../events/domain/ports/notifier.port';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';

@Injectable()
export class TelegramNotifierAdapter implements NotifierPort {
  private readonly logger = new Logger(TelegramNotifierAdapter.name);
  private bot?: Bot;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

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

    const recipients = await this.users.listRecipients();
    const failures: Error[] = [];
    let delivered = 0;

    for (const recipient of recipients) {
      try {
        await this.sendToRecipient(recipient.telegramId, message);
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