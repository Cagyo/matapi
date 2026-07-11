import { Inject, Injectable, Logger } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import { MOTION_ALERT, MotionAlertPort } from '../domain/ports/motion-alert.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';
import { SNAPSHOT, SnapshotPort } from '../domain/ports/snapshot.port';

/**
 * Records the start of a motion event (spec 20). Invoked by Motion's
 * `on_event_start` hook via the HTTP listener. Opens a `motion_events` row,
 * best-effort grabs a snapshot for the notification, and raises a motion
 * alert. Never throws to the caller (the controller wraps it), but resolves
 * the camera defensively so a misconfigured hook does not crash the row.
 */
@Injectable()
export class RecordMotionStartUseCase {
  private readonly logger = new Logger(RecordMotionStartUseCase.name);

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
    @Inject(SNAPSHOT) private readonly snapshot: SnapshotPort,
    @Inject(MOTION_ALERT) private readonly alert: MotionAlertPort,
  ) {}

  async execute(cameraRef?: string): Promise<void> {
    const camera = await this.resolveCamera(cameraRef);
    if (!camera) {
      this.logger.warn(
        `Motion start for unknown camera "${cameraRef ?? ''}" — no event recorded`,
      );
      return;
    }

    const startedAt = new Date();
    await this.writer.createEvent(camera.id, startedAt);

    let photo: Buffer | null = null;
    try {
      photo = await this.snapshot.grab(camera.id, camera.name);
    } catch (error) {
      this.logger.warn(
        `Snapshot for motion alert failed (${camera.name}): ${
          (error as Error).message
        }`,
      );
    }

    await this.alert.motionStarted(camera.name, startedAt, photo, camera.id);
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
