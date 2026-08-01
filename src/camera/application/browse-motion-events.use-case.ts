import { Inject, Injectable } from '@nestjs/common';
import {
  BrowseMotionEvent,
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import {
  ARCHIVE_VERIFICATION,
  type ArchiveVerificationPort,
} from '../../archive/application/ports/archive-verification.port';

export const BROWSE_MOTION_EVENTS_LIMIT = 20;

export interface BrowseMotionEventsResult {
  events: BrowseMotionEvent[];
  hasMore: boolean;
}

@Injectable()
export class BrowseMotionEventsUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(ARCHIVE_VERIFICATION) private readonly archive: ArchiveVerificationPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async latest(
    limit = BROWSE_MOTION_EVENTS_LIMIT,
  ): Promise<BrowseMotionEventsResult> {
    await this.availability?.requireReady('motion');
    return this.capWithVerification(await this.media.listLatestEvents(limit + 1), limit);
  }

  async between(
    start: Date,
    end: Date,
    limit = BROWSE_MOTION_EVENTS_LIMIT,
  ): Promise<BrowseMotionEventsResult> {
    await this.availability?.requireReady('motion');
    return this.capWithVerification(
      await this.media.listEventsStartedBetween(start, end, limit + 1),
      limit,
    );
  }

  private async capWithVerification(
    events: BrowseMotionEvent[],
    limit: number,
  ): Promise<BrowseMotionEventsResult> {
    const visible = events.slice(0, limit);
    const projected = await Promise.all(visible.map(async (event) => {
      const archiveWebViewLink = event.archiveArtifactId === null
        ? null
        : (await this.archive.inspect(event.archiveArtifactId)).webViewLink;
      return { ...event, archiveWebViewLink };
    }));
    return {
      events: projected,
      hasMore: events.length > limit,
    };
  }
}
