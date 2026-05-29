import { Injectable } from '@nestjs/common';
import { NotificationMessage, NotifierPort } from '../domain/ports/notifier.port';

@Injectable()
export class EventNotifierService implements NotifierPort {
  private notifier?: NotifierPort;

  register(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  clear(): void {
    this.notifier = undefined;
  }

  isReady(): boolean {
    return this.notifier?.isReady() ?? false;
  }

  async notify(message: NotificationMessage): Promise<void> {
    if (!this.notifier?.isReady()) {
      throw new Error('Notifier is not ready');
    }

    await this.notifier.notify(message);
  }
}