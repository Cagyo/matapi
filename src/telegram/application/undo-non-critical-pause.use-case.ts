import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import {
  NOTIFICATION_PAUSE_REPOSITORY,
  NotificationPauseRepositoryPort,
  UndoNonCriticalPauseResult,
} from '../domain/ports/notification-pause-repository.port';

/**
 * Foundation use case (spec 12/19): undo the most recent timed pause a user
 * created, using its receipt. The requesting user ID is always required — a
 * bare receipt is never accepted. The discriminated result is returned
 * unchanged so a future interface layer can render `expired`, `superseded`,
 * and `consumed` distinctly. Not wired to any bot command yet.
 */
@Injectable()
export class UndoNonCriticalPauseUseCase {
  constructor(
    @Inject(NOTIFICATION_PAUSE_REPOSITORY)
    private readonly pauses: NotificationPauseRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  execute(
    userId: number,
    receiptId: number,
  ): Promise<UndoNonCriticalPauseResult> {
    return this.pauses.undoNonCriticalPause(userId, receiptId, this.clock.now());
  }
}
