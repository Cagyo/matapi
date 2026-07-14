import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { HomeActionReceipt } from '../domain/home-action-receipt';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { USER_REPOSITORY, type UserRepositoryPort } from '../domain/ports/user-repository.port';
import { HOME_ACTION_REPOSITORY, type HomeActionRepositoryPort } from './ports/home-action-repository.port';
import { NotificationTargetDirectoryService } from './notification-target-directory.service';

export interface NotificationScreen {
  legacyMuted: boolean;
  timedPauseUntil: Date | null;
  quietStart: string | null;
  quietEnd: string | null;
  mutedTargetCount: number;
  undoPause: Extract<HomeActionReceipt, { kind: 'undo-non-critical-pause' }> | null;
  undoQuietHours: Extract<HomeActionReceipt, { kind: 'undo-quiet-hours' }> | null;
}

@Injectable()
export class GetNotificationScreenUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly targets: NotificationTargetDirectoryService,
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: { userId: number; chatId: number }): Promise<NotificationScreen> {
    const now = this.clock.now();
    const [user, targets, undoPause, undoQuietHours] = await Promise.all([
      this.users.findByTelegramId(input.userId),
      this.targets.listEnabled(input.userId),
      this.actions.findCurrentUndo({ userId: input.userId, chatId: input.chatId, kind: 'undo-non-critical-pause', now }),
      this.actions.findCurrentUndo({ userId: input.userId, chatId: input.chatId, kind: 'undo-quiet-hours', now }),
    ]);
    if (!user) throw new UserNotFoundError(String(input.userId));
    return {
      legacyMuted: user.muted,
      timedPauseUntil: user.nonCriticalPausedUntil,
      quietStart: user.quietStart,
      quietEnd: user.quietEnd,
      mutedTargetCount: targets.filter((target) => target.muted).length,
      undoPause: undoPause?.kind === 'undo-non-critical-pause' ? undoPause : null,
      undoQuietHours: undoQuietHours?.kind === 'undo-quiet-hours' ? undoQuietHours : null,
    };
  }
}
