import { Injectable, Logger } from '@nestjs/common';
import { Bot } from 'grammy';
import { DirectMessengerPort } from '../domain/ports/direct-messenger.port';

/**
 * Sends a private message to a single Telegram user. The bot reference is
 * injected by `GrammyBotGateway` once the runner is up; in mock mode the
 * adapter logs instead so the use cases still run end-to-end.
 */
@Injectable()
export class TelegramDirectMessenger implements DirectMessengerPort {
  private readonly logger = new Logger(TelegramDirectMessenger.name);
  private bot?: Bot;

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  clearBot(): void {
    this.bot = undefined;
  }

  async send(telegramId: number, text: string): Promise<void> {
    if (!this.bot) {
      this.logger.log(`[mock dm → ${telegramId}] ${text}`);
      return;
    }
    try {
      await this.bot.api.sendMessage(telegramId, text);
    } catch (err) {
      this.logger.warn(
        `direct message to ${telegramId} failed: ${(err as Error).message}`,
      );
    }
  }

  async sendConfirmed(telegramId: number, text: string): Promise<boolean> {
    if (!this.bot) return false;
    await this.bot.api.sendMessage(telegramId, text);
    return true;
  }
}
