import { Inject, Injectable } from '@nestjs/common';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

export const BROWSE_MOTION_EVENTS_LIMIT = 20;

export interface BrowseMotionEventsResult {
  events: MotionEvent[];
  hasMore: boolean;
}

@Injectable()
export class BrowseMotionEventsUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
  ) {}

  async latest(
    limit = BROWSE_MOTION_EVENTS_LIMIT,
  ): Promise<BrowseMotionEventsResult> {
    return this.cap(await this.media.listLatestEvents(limit + 1), limit);
  }

  async between(
    start: Date,
    end: Date,
    limit = BROWSE_MOTION_EVENTS_LIMIT,
  ): Promise<BrowseMotionEventsResult> {
    return this.cap(
      await this.media.listEventsStartedBetween(start, end, limit + 1),
      limit,
    );
  }

  private cap(events: MotionEvent[], limit: number): BrowseMotionEventsResult {
    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit,
    };
  }
}
