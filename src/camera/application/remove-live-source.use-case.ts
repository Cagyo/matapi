import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
} from '../domain/ports/live-source-repository.port';
import {
  LIVE_SOURCE_SESSION_CONTROL,
  type LiveSourceSessionControlPort,
} from '../domain/ports/live-source-session-control.port';

@Injectable()
export class RemoveLiveSourceUseCase {
  constructor(
    @Inject(LIVE_SOURCE_SESSION_CONTROL)
    private readonly sessions: LiveSourceSessionControlPort,
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
  ) {}

  async execute(cameraId: string): Promise<void> {
    await this.sessions.stopActiveSession();
    await this.repository.remove(cameraId);
  }
}
