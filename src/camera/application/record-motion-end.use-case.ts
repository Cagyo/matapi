import { Inject, Injectable, Logger } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import { RegisterCompletedMotionVideosUseCase } from './register-completed-motion-videos.use-case';
import {
  CompletedMotionVideoRecoveryScheduler,
} from './completed-motion-video-recovery.scheduler';

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
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
    private readonly registerCompletedVideos?: Pick<RegisterCompletedMotionVideosUseCase, 'executeForEvent'>,
    private readonly recovery?: Pick<CompletedMotionVideoRecoveryScheduler, 'wake'>,
  ) {}

  async execute(cameraRef: string | undefined, videoPath: string): Promise<void> {
    await this.availability?.requireReady('motion');
    const camera = await this.resolveCamera(cameraRef);
    if (!camera) {
      this.logger.warn(
        `Motion end for unknown camera "${cameraRef ?? ''}" — nothing to close`,
      );
      return;
    }

    const endedAt = new Date();
    await this.availability?.requireReady('motion');
    const closed = await this.writer.closeLatestOpenEvent(
      camera.id,
      endedAt,
      videoPath,
    );
    if (closed) {
      await this.registerAndWake(closed.id);
      return;
    }

    const startedAt = motionFileStartedAt(videoPath) ?? endedAt;
    await this.availability?.requireReady('motion');
    await this.writer.createEvent(camera.id, startedAt);
    await this.availability?.requireReady('motion');
    const standalone = await this.writer.closeLatestOpenEvent(camera.id, endedAt, videoPath);
    if (standalone) await this.registerAndWake(standalone.id);
    this.logger.log('Motion end created a standalone video event');
  }

  private async registerAndWake(eventId: number): Promise<void> {
    try {
      await this.registerCompletedVideos?.executeForEvent(eventId);
    } finally {
      this.recovery?.wake('motion-event');
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
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date;
}
