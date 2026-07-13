import { Injectable, Logger } from '@nestjs/common';
import type { Bot } from 'grammy';
import type { LiveStreamMessageReference } from '../../camera/domain/live-stream.entity';
import type { LiveStreamMessageCleanupPort } from '../../camera/domain/ports/live-stream-message-cleanup.port';
import type { TelegramContext } from '../interfaces/telegram-context';

/** Deletes expired/stopped live-view messages through the active grammY bot. */
@Injectable()
export class TelegramLiveStreamMessageCleanupAdapter implements LiveStreamMessageCleanupPort {
  private readonly logger = new Logger(TelegramLiveStreamMessageCleanupAdapter.name);
  private bot?: Bot<TelegramContext>;

  setBot(bot: Bot<TelegramContext>): void {
    this.bot = bot;
  }

  clearBot(): void {
    this.bot = undefined;
  }

  async delete(reference: LiveStreamMessageReference): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.deleteMessage(reference.chatId, reference.messageId);
    } catch {
      this.logger.warn('Live-view watch-message deletion failed; continuing cleanup');
    }
  }
}
