import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  HOME_PENDING_TTL_MS,
  type HomeIdentity,
  type HomeView,
} from '../domain/home-session';
import type { Locale } from '../domain/locale';
import {
  HOME_SESSION_STORE,
  type HomeSessionStorePort,
} from '../domain/ports/home-session-store.port';
import {
  HOME_TOKEN_GENERATOR,
  type HomeTokenGeneratorPort,
} from '../domain/ports/home-token-generator.port';
import type { Role } from '../domain/role';
import { GetHomeScreenUseCase } from './get-home-screen.use-case';
import { homeViewForScreen } from './home-screen';
import {
  HOME_MESSAGE_DELIVERY,
  type HomeMessageDeliveryPort,
} from './ports/home-message-delivery.port';

export interface OpenHomeInput {
  userId: number;
  chatId: number;
  locale: Locale;
  role: Role;
  view: HomeView;
}

export type OpenHomeResult =
  | { kind: 'opened'; active: HomeIdentity; view: HomeView }
  | { kind: 'superseded' };

@Injectable()
export class OpenHomeUseCase {
  constructor(
    @Inject(HOME_SESSION_STORE) private readonly sessions: HomeSessionStorePort,
    @Inject(HOME_TOKEN_GENERATOR) private readonly tokens: HomeTokenGeneratorPort,
    private readonly screens: GetHomeScreenUseCase,
    @Inject(HOME_MESSAGE_DELIVERY) private readonly delivery: HomeMessageDeliveryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: OpenHomeInput): Promise<OpenHomeResult> {
    const screen = await this.screens.execute({
      userId: input.userId,
      chatId: input.chatId,
      role: input.role,
      view: input.view,
    });
    const view = homeViewForScreen(screen);
    const now = this.clock.now();
    const reservation = await this.sessions.reserveNew({
      userId: input.userId,
      chatId: input.chatId,
      token: this.tokens.generate(),
      view,
      now,
      expiresAt: new Date(now.getTime() + HOME_PENDING_TTL_MS),
    });
    let sent: { messageId: number };
    try {
      sent = await this.delivery.send({
        chatId: input.chatId,
        locale: input.locale,
        identity: {
          userId: reservation.userId,
          chatId: reservation.chatId,
          token: reservation.token,
          revision: reservation.revision,
        },
        screen,
      });
    } catch (error) {
      await this.abandonWithoutMasking(reservation);
      throw error;
    }

    const promotion = await this.sessions.promoteNew(reservation, sent.messageId, this.clock.now());
    if (promotion.kind === 'lost') {
      await this.stripWithoutFailing(input.chatId, sent.messageId);
      return { kind: 'superseded' };
    }

    if (promotion.previous) {
      await this.deleteWithoutFailing(promotion.previous.chatId, promotion.previous.messageId);
    }
    return { kind: 'opened', active: promotion.active, view };
  }

  private async abandonWithoutMasking(reservation: Parameters<HomeSessionStorePort['abandon']>[0]): Promise<void> {
    try {
      await this.sessions.abandon(reservation);
    } catch {
      // The send failure is the actionable failure at this boundary.
    }
  }

  private async stripWithoutFailing(chatId: number, messageId: number): Promise<void> {
    try {
      await this.delivery.stripKeyboard(chatId, messageId);
    } catch {
      // Superseded and previous keyboards are cleanup only.
    }
  }

  private async deleteWithoutFailing(chatId: number, messageId: number): Promise<void> {
    try {
      await this.delivery.deleteMessage(chatId, messageId);
    } catch {
      // The replacement is already authoritative; deletion is visual cleanup only.
    }
  }
}
