import { Injectable, Logger } from '@nestjs/common';
import type { Bot } from 'grammy';
import {
  CameraSourceMessageDeletionError,
  type CameraSourceMessagePort,
} from '../application/ports/camera-source-message.port';
import type { TelegramContext } from '../interfaces/telegram-context';

/**
 * Deletes one credential-bearing reply through the active grammY bot.
 *
 * Two deliberate divergences from `TelegramLiveStreamMessageCleanupAdapter`,
 * which is otherwise the same shape:
 *
 * 1. **It fails closed.** No bot means the deletion did not happen, so the
 *    call rejects rather than resolving into a silent no-op. A caller that was
 *    told "deleted" about a credential still sitting in a chat is worse than
 *    one that knows it failed.
 * 2. **It never re-throws grammY's error.** A `GrammyError` description quotes
 *    the chat and the message it refused, and this call's message is a
 *    credential. Only `CameraSourceMessageDeletionError` — which carries
 *    nothing — leaves this class.
 */
@Injectable()
export class TelegramCameraSourceMessageAdapter implements CameraSourceMessagePort {
  private readonly logger = new Logger(TelegramCameraSourceMessageAdapter.name);
  private bot?: Bot<TelegramContext>;

  setBot(bot: Bot<TelegramContext>): void {
    this.bot = bot;
  }

  clearBot(): void {
    this.bot = undefined;
  }

  async delete(chatId: number, messageId: number): Promise<void> {
    const bot = this.bot;
    if (!bot) {
      this.logger.warn('camera source message deletion requested before the bot was ready');
      throw new CameraSourceMessageDeletionError();
    }
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch {
      // Caught and discarded unread — see the class note.
      this.logger.warn('camera source message deletion was refused');
      throw new CameraSourceMessageDeletionError();
    }
  }
}
