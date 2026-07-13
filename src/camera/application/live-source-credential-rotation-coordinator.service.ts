import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
} from '../domain/ports/live-source-repository.port';

@Injectable()
export class LiveSourceCredentialRotationCoordinator implements OnModuleInit {
  constructor(
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.rotate();
  }
}
