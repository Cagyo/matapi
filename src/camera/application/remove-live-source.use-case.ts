import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
} from '../domain/ports/live-source-repository.port';
import {
  LIVE_SOURCE_SESSION_CONTROL,
  type LiveSourceSessionControlPort,
} from '../domain/ports/live-source-session-control.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

@Injectable()
export class RemoveLiveSourceUseCase {
  constructor(
    @Inject(LIVE_SOURCE_SESSION_CONTROL)
    private readonly sessions: LiveSourceSessionControlPort,
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async execute(cameraId: string): Promise<void> {
    await this.availability?.requireReady('rtsp');
    await this.sessions.stopActiveSession();
    await this.repository.remove(cameraId);
  }
}
