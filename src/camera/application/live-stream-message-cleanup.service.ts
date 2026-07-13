import { Injectable } from '@nestjs/common';
import type { LiveStreamMessageCleanupPort } from '../domain/ports/live-stream-message-cleanup.port';
import type { LiveStreamMessageReference } from '../domain/live-stream.entity';

/**
 * Camera-owned runtime seam for deleting Telegram live-view messages.
 * Telegram registers its adapter at bootstrap, avoiding a module cycle.
 */
@Injectable()
export class LiveStreamMessageCleanupService implements LiveStreamMessageCleanupPort {
  private delegate?: LiveStreamMessageCleanupPort;

  register(delegate: LiveStreamMessageCleanupPort): void {
    this.delegate = delegate;
  }

  clear(): void {
    this.delegate = undefined;
  }

  async delete(reference: LiveStreamMessageReference): Promise<void> {
    if (this.delegate) await this.delegate.delete(reference);
  }
}
