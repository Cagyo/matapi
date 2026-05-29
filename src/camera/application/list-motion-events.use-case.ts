import { Inject, Injectable } from '@nestjs/common';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

/** `/camera events [date]` — spec 14. Lists motion events for a day. */
@Injectable()
export class ListMotionEventsUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
  ) {}

  execute(day: Date): Promise<MotionEvent[]> {
    return this.media.listEventsOnDay(day);
  }
}
