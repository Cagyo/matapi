import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_PAUSE_REPOSITORY,
  type CompareAndSetQuietHoursCommand,
  type CompareAndSetQuietHoursResult,
  type NotificationPauseRepositoryPort,
} from '../domain/ports/notification-pause-repository.port';

@Injectable()
export class CompareAndSetQuietHoursUseCase {
  constructor(
    @Inject(NOTIFICATION_PAUSE_REPOSITORY)
    private readonly pauses: NotificationPauseRepositoryPort,
  ) {}

  execute(command: CompareAndSetQuietHoursCommand): Promise<CompareAndSetQuietHoursResult> {
    return this.pauses.compareAndSetQuietHours(command);
  }
}
