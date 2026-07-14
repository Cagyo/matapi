import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { Locale } from '../domain/locale';
import type { HomeIdentity } from '../domain/home-session';
import {
  HOME_SESSION_STORE,
  type HomeSessionStorePort,
} from '../domain/ports/home-session-store.port';
import {
  HOME_MESSAGE_DELIVERY,
  type HomeMessageDeliveryPort,
} from './ports/home-message-delivery.port';

export interface CloseHomeInput {
  identity: HomeIdentity;
  locale: Locale;
}

export type CloseHomeResult = 'closed' | 'stale';

@Injectable()
export class CloseHomeUseCase {
  private readonly logger = new Logger(CloseHomeUseCase.name);

  constructor(
    @Inject(HOME_SESSION_STORE) private readonly sessions: HomeSessionStorePort,
    @Inject(HOME_MESSAGE_DELIVERY) private readonly delivery: HomeMessageDeliveryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: CloseHomeInput): Promise<CloseHomeResult> {
    const result = await this.sessions.close({
      ...input.identity,
      now: this.clock.now(),
    });
    if (result === 'stale') return 'stale';

    try {
      await this.delivery.closeMessage(
        input.identity.chatId,
        input.identity.messageId,
        input.locale,
      );
    } catch {
      this.logger.warn('Home close message delivery failed');
    }
    return 'closed';
  }
}
