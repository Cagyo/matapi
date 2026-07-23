import { Inject, Injectable } from '@nestjs/common';
import {
  BrowseMotionEvent,
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

export const BROWSE_MOTION_EVENTS_LIMIT = 20;

export interface BrowseMotionEventsResult {
  events: BrowseMotionEvent[];
  hasMore: boolean;
}

@Injectable()
export class BrowseMotionEventsUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async latest(
    limit = BROWSE_MOTION_EVENTS_LIMIT,
  ): Promise<BrowseMotionEventsResult> {
    await this.availability?.requireReady('motion');
    return this.cap(await this.media.listLatestEvents(limit + 1), limit);
  }

  async between(
    start: Date,
    end: Date,
    limit = BROWSE_MOTION_EVENTS_LIMIT,
  ): Promise<BrowseMotionEventsResult> {
    await this.availability?.requireReady('motion');
    return this.cap(
      await this.media.listEventsStartedBetween(start, end, limit + 1),
      limit,
    );
  }

  private cap(events: BrowseMotionEvent[], limit: number): BrowseMotionEventsResult {
    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit,
    };
  }
}
