import { Inject, Injectable, Logger } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';

/**
 * Records the end of a motion event (spec 20). Invoked by Motion's
 * `on_event_end` / `on_movie_end` hook. Closes the latest open event for the
 * camera, stamping `endedAt` and the recorded video path. The video stays
 * `uploaded_to_gdrive = false`, queued for the Drive sync (spec 21).
 */
@Injectable()
export class RecordMotionEndUseCase {
  private readonly logger = new Logger(RecordMotionEndUseCase.name);

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
  ) {}

  async execute(cameraRef: string | undefined, videoPath: string): Promise<void> {
    const camera = await this.resolveCamera(cameraRef);
    if (!camera) {
      this.logger.warn(
        `Motion end for unknown camera "${cameraRef ?? ''}" — nothing to close`,
      );
      return;
    }

    const closed = await this.writer.closeLatestOpenEvent(
      camera.id,
      new Date(),
      videoPath,
    );
    if (!closed) {
      this.logger.warn(
        `Motion end for ${camera.name} with no open event — video ${videoPath} not linked`,
      );
    }
  }

  private async resolveCamera(cameraRef?: string): Promise<Camera | null> {
    const cameras = await this.media.listCameras();
    if (cameras.length === 0) return null;
    if (!cameraRef) return cameras[0];

    const ref = cameraRef.toLowerCase();
    return (
      cameras.find(
        (c) => c.id.toLowerCase() === ref || c.name.toLowerCase() === ref,
      ) ?? cameras[0]
    );
  }
}
