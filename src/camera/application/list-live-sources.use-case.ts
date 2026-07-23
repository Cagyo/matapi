import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
  type RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

@Injectable()
export class ListLiveSourcesUseCase {
  constructor(
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async execute(): Promise<RedactedLiveSource[]> {
    await this.availability?.requireReady('rtsp');
    return this.repository.listRedacted();
  }
}
