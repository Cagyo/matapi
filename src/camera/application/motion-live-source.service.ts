import { Inject, Injectable } from '@nestjs/common';
import { LiveStreamSourceUnavailableError } from '../domain/errors/live-stream-source-unavailable.error';
import type { LiveStreamSource } from '../domain/live-stream.entity';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

const MOTION_MJPEG_UPSTREAM = 'http://127.0.0.1:8081/?action=stream';

/** Resolves only the installer-owned Motion MJPEG route for enabled cameras. */
@Injectable()
export class MotionLiveSourceService {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
  ) {}

  async resolve(cameraName?: string): Promise<LiveStreamSource> {
    const camera = cameraName
      ? await this.media.findCameraByName(cameraName)
      : (await this.media.listCameras())[0] ?? null;

    if (!camera || !camera.enabled || camera.type !== 'motion') {
      throw new LiveStreamSourceUnavailableError();
    }

    return {
      kind: 'motion-mjpeg',
      cameraId: camera.id,
      cameraName: camera.name,
      upstreamUrl: MOTION_MJPEG_UPSTREAM,
    };
  }
}
