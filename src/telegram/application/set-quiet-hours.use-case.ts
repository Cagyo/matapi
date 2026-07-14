import { Inject, Injectable } from '@nestjs/common';
import { parseQuietHoursRange } from '../domain/quiet-hours.value-object';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { NOTIFICATION_PAUSE_REPOSITORY, type NotificationPauseRepositoryPort } from '../domain/ports/notification-pause-repository.port';

export interface QuietHoursResult {
  /** `null` when disabled. */
  start: string | null;
  end: string | null;
}

/** Spec 12 — `/quiet_hours HH:MM-HH:MM | off`. */
@Injectable()
export class SetQuietHoursUseCase {
  constructor(
    @Inject(NOTIFICATION_PAUSE_REPOSITORY) private readonly pauses: NotificationPauseRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(userId: number, raw: string): Promise<QuietHoursResult> {
    const range = parseQuietHoursRange(raw);
    if (!range) {
      await this.set(userId, null, null);
      return { start: null, end: null };
    }
    await this.set(userId, range.start, range.end);
    return { start: range.start, end: range.end };
  }

  private async set(userId: number, start: string | null, end: string | null): Promise<void> {
    const state = await this.pauses.getNotificationPauseState(userId);
    if (!state) throw new UserNotFoundError(String(userId));
    const result = await this.pauses.compareAndSetQuietHours({ userId, expectedRevision: state.revision, start, end, now: this.clock.now() });
    if (result.kind === 'not_found') throw new UserNotFoundError(String(userId));
    if (result.kind === 'conflict') await this.set(userId, start, end);
  }
}
