import { Injectable } from '@nestjs/common';
import {
  NotificationRecipient,
  RecipientDirectoryPort,
} from '../domain/ports/recipient.port';

/**
 * Runtime-registered delegate for `RecipientDirectoryPort` (spec 19).
 *
 * Mirrors `EventNotifierService`: the `events` context owns the port, the
 * `telegram` context binds the real implementation at bootstrap via
 * `register()`. Until then (and in mock mode without users) it reports no
 * recipients, so the pipeline falls back to a broadcast.
 */
@Injectable()
export class RecipientDirectoryService implements RecipientDirectoryPort {
  private directory?: RecipientDirectoryPort;

  register(directory: RecipientDirectoryPort): void {
    this.directory = directory;
  }

  clear(): void {
    this.directory = undefined;
  }

  async listRecipients(): Promise<NotificationRecipient[]> {
    return this.directory ? this.directory.listRecipients() : [];
  }

  async isSensorMuted(telegramId: number, sensorId: string): Promise<boolean> {
    return this.directory
      ? this.directory.isSensorMuted(telegramId, sensorId)
      : false;
  }
}
