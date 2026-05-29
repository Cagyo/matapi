import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationMessage,
  NotificationPhoto,
  NotifierPort,
} from '../../events/domain/ports/notifier.port';

/**
 * Dev-mode `NotifierPort` implementation. Replaces Telegram delivery with
 * structured logs so the event pipeline (enqueue → drain → mark sent) works
 * end-to-end without a bot token. Selected in `telegram.module.ts` when
 * `BOT_MODE=mock` or `TELEGRAM_BOT_TOKEN` is absent.
 */
@Injectable()
export class ConsoleNotifierAdapter implements NotifierPort {
  private readonly logger = new Logger(ConsoleNotifierAdapter.name);

  isReady(): boolean {
    return true;
  }

  async notify(message: NotificationMessage): Promise<void> {
    const channel = message.asFile ? 'document' : 'message';
    this.logger.log(`[mock-${channel}]\n${message.text}`);
  }

  async notifyUser(telegramId: number, message: NotificationMessage): Promise<void> {
    this.logger.log(`[mock-message → ${telegramId}]\n${message.text}`);
  }

  async notifyUserPhoto(telegramId: number, photo: NotificationPhoto): Promise<void> {
    this.logger.log(
      `[mock-photo → ${telegramId}] (${photo.buffer.length} bytes)\n${photo.caption}`,
    );
  }
}
