import { Inject, Injectable } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

/** Lists configured cameras for config export (spec 16). */
@Injectable()
export class ListCamerasUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
  ) {}

  execute(): Promise<Camera[]> {
    return this.media.listCameras();
  }
}
