import { Inject, Injectable } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
  type RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';

@Injectable()
export class ListLiveSourcesUseCase {
  constructor(
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
  ) {}

  execute(): Promise<RedactedLiveSource[]> {
    return this.repository.listRedacted();
  }
}
