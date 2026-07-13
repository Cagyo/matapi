import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { LegacyNotificationPauseActiveError } from '../domain/errors/legacy-notification-pause-active.error';
import { NotificationPauseConflictError } from '../domain/errors/notification-pause-conflict.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  NOTIFICATION_PAUSE_REPOSITORY,
  NotificationPauseRepositoryPort,
  PauseDurationHours,
} from '../domain/ports/notification-pause-repository.port';

const SUPPORTED_DURATIONS: readonly PauseDurationHours[] = [1, 4, 8];
const MS_PER_HOUR = 60 * 60 * 1000;

export interface PauseNonCriticalResult {
  pausedUntil: Date;
  revision: number;
  receiptId: number;
}

/**
 * Foundation use case (spec 12/19): pause a user's non-critical notifications
 * for exactly 1, 4, or 8 hours. Critical alarms are unaffected. No new
 * indefinite pause can be created here. Not wired to any bot command yet.
 */
@Injectable()
export class PauseNonCriticalNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_PAUSE_REPOSITORY)
    private readonly pauses: NotificationPauseRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    userId: number,
    hours: PauseDurationHours,
  ): Promise<PauseNonCriticalResult> {
    if (!SUPPORTED_DURATIONS.includes(hours)) {
      throw new RangeError(
        `Unsupported pause duration: ${String(hours)}h (allowed: 1, 4, 8).`,
      );
    }

    // Read the clock exactly once so the "previous still future?" normalization
    // is measured from the same instant as the new deadline.
    const now = this.clock.now();
    const pausedUntil = new Date(now.getTime() + hours * MS_PER_HOUR);

    const state = await this.pauses.getNotificationPauseState(userId);
    if (!state) throw new UserNotFoundError(String(userId));
    if (state.legacyMuted) throw new LegacyNotificationPauseActiveError();

    const result = await this.pauses.applyNonCriticalPause({
      userId,
      expectedRevision: state.revision,
      pausedUntil,
      now,
    });

    switch (result.kind) {
      case 'applied':
        return {
          pausedUntil,
          revision: result.state.revision,
          receiptId: result.receiptId,
        };
      case 'not_found':
        throw new UserNotFoundError(String(userId));
      case 'legacy_active':
        throw new LegacyNotificationPauseActiveError();
      case 'conflict':
        throw new NotificationPauseConflictError();
    }
  }
}
