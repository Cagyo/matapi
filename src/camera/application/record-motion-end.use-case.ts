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
 * camera when one exists; otherwise creates a standalone closed row for the
 * completed movie file. The video stays `uploaded_to_gdrive = false`, queued
 * for the Drive sync (spec 21).
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

    const endedAt = new Date();
    const closed = await this.writer.closeLatestOpenEvent(
      camera.id,
      endedAt,
      videoPath,
    );
    if (closed) {
      return;
    }

    const startedAt = motionFileStartedAt(videoPath) ?? endedAt;
    await this.writer.createEvent(camera.id, startedAt);
    await this.writer.closeLatestOpenEvent(camera.id, endedAt, videoPath);
    this.logger.log(
      `Motion end for ${camera.name} with no open event — created standalone video event ${videoPath}`,
    );
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

function motionFileStartedAt(videoPath: string): Date | null {
  const match =
    /(?:^|[\\/])(\d{4})[\\/](\d{2})[\\/](\d{2})[\\/](\d{2})(\d{2})(\d{2})-[^\\/]+$/.exec(
      videoPath,
    );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date;
}
