import { Inject, Injectable } from '@nestjs/common';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

/** `/camera events [date]` — spec 14. Lists motion events for a day. */
@Injectable()
export class ListMotionEventsUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async execute(day: Date): Promise<MotionEvent[]> {
    await this.availability?.requireReady('motion');
    return this.media.listEventsOnDay(day);
  }
}
