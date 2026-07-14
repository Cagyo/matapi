import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { HOME_PENDING_TTL_MS, type HomeIdentity, type HomeView } from '../domain/home-session';
import type { Locale } from '../domain/locale';
import {
  HOME_SESSION_STORE,
  type HomeSessionStorePort,
} from '../domain/ports/home-session-store.port';
import type { Role } from '../domain/role';
import { GetHomeScreenUseCase } from './get-home-screen.use-case';
import { homeViewForScreen } from './home-screen';
import { OpenHomeUseCase } from './open-home.use-case';
import {
  HOME_MESSAGE_DELIVERY,
  type HomeMessageDeliveryPort,
} from './ports/home-message-delivery.port';

export interface RenderHomeInput {
  active: HomeIdentity;
  locale: Locale;
  role: Role;
  view: HomeView;
}

export type RenderHomeResult =
  | { kind: 'rendered' | 'reopened'; active: HomeIdentity; view: HomeView }
  | { kind: 'stale' | 'superseded' | 'delivery_failed' };

@Injectable()
export class RenderHomeUseCase {
  constructor(
    @Inject(HOME_SESSION_STORE) private readonly sessions: HomeSessionStorePort,
    private readonly screens: GetHomeScreenUseCase,
    @Inject(HOME_MESSAGE_DELIVERY) private readonly delivery: HomeMessageDeliveryPort,
    private readonly openHome: OpenHomeUseCase,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: RenderHomeInput): Promise<RenderHomeResult> {
    const screen = await this.screens.execute({
      userId: input.active.userId,
      role: input.role,
      view: input.view,
    });
    const view = homeViewForScreen(screen);
    const now = this.clock.now();
    const reserved = await this.sessions.reserveEdit({
      active: input.active,
      view,
      now,
      expiresAt: new Date(now.getTime() + HOME_PENDING_TTL_MS),
    });
    if (reserved.kind !== 'reserved') return { kind: 'stale' };

    const pending = reserved.reservation;
    const identity: HomeIdentity = {
      userId: pending.userId,
      chatId: pending.chatId,
      messageId: pending.messageId!,
      token: pending.token,
      revision: pending.revision,
    };

    try {
      await this.delivery.edit({ identity, locale: input.locale, screen });
    } catch {
      await this.abandonWithoutMasking(pending);
      return this.reopen({ ...input, view });
    }

    const promotion = await this.sessions.promoteEdit(pending, this.clock.now());
    return promotion.kind === 'promoted'
      ? { kind: 'rendered', active: promotion.active, view }
      : { kind: 'superseded' };
  }

  private async reopen(input: RenderHomeInput): Promise<RenderHomeResult> {
    try {
      const reopened = await this.openHome.execute({
        userId: input.active.userId,
        chatId: input.active.chatId,
        locale: input.locale,
        role: input.role,
        view: input.view,
      });
      return reopened.kind === 'opened'
        ? { kind: 'reopened', active: reopened.active, view: reopened.view }
        : { kind: 'superseded' };
    } catch {
      return { kind: 'delivery_failed' };
    }
  }

  private async abandonWithoutMasking(reservation: Parameters<HomeSessionStorePort['abandon']>[0]): Promise<void> {
    try {
      await this.sessions.abandon(reservation);
    } catch {
      // The failed edit is handled by the new-message recovery protocol.
    }
  }
}
