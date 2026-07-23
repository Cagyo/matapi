import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
  type RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';

@Injectable()
export class ListLiveSourcesUseCase {
  constructor(
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
    private readonly gate?: RtspSourceStartGate,
  ) {}

  async execute(): Promise<RedactedLiveSource[]> {
    await this.availability?.requireReady('rtsp');
    this.gate?.assertCanStart('rtsp');
    return this.repository.listRedacted();
  }
}
