import { Injectable } from '@nestjs/common';
import type { LiveStreamMessageCleanupPort } from '../domain/ports/live-stream-message-cleanup.port';

/** Interim binding until Task 5 supplies the Telegram-owned implementation. */
@Injectable()
export class NoopLiveStreamMessageCleanupAdapter implements LiveStreamMessageCleanupPort {
  async delete(): Promise<void> {}
}
