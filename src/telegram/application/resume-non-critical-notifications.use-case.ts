import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { NotificationPauseConflictError } from '../domain/errors/notification-pause-conflict.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  NOTIFICATION_PAUSE_REPOSITORY,
  NotificationPauseRepositoryPort,
  NotificationPauseState,
} from '../domain/ports/notification-pause-repository.port';

export interface ResumeNonCriticalResult {
  state: NotificationPauseState;
  changed: boolean;
}

/**
 * Foundation use case (spec 12): resume notifications by clearing both the
 * legacy indefinite mute and any timed non-critical pause atomically. Clearing
 * is by column presence — a deadline already in the past still counts as
 * clearable. Not wired to any bot command yet.
 */
@Injectable()
export class ResumeNonCriticalNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_PAUSE_REPOSITORY)
    private readonly pauses: NotificationPauseRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(userId: number): Promise<ResumeNonCriticalResult> {
    const state = await this.pauses.getNotificationPauseState(userId);
    if (!state) throw new UserNotFoundError(String(userId));

    const result = await this.pauses.resumeNotifications({
      userId,
      expectedRevision: state.revision,
      now: this.clock.now(),
    });

    switch (result.kind) {
      case 'applied':
        return { state: result.state, changed: result.changed };
      case 'not_found':
        throw new UserNotFoundError(String(userId));
      case 'conflict':
        throw new NotificationPauseConflictError();
    }
  }
}
