import { Inject, Injectable, Optional } from '@nestjs/common';
import { LiveStreamSourceUnavailableError } from '../domain/errors/live-stream-source-unavailable.error';
import type { LiveStreamSource } from '../domain/live-stream.entity';
import type { Camera } from '../domain/camera.entity';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
} from '../domain/ports/live-source-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';

const MOTION_MJPEG_UPSTREAM = 'http://127.0.0.1:8081/?action=stream';

/** Resolves configured RTSP when ready, otherwise the installer-owned Motion route. */
@Injectable()
export class LiveStreamSourceResolverService {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Optional() @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly liveSources?: LiveSourceRepositoryPort,
    @Optional() @Inject(FEATURE_AVAILABILITY)
    private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async resolve(cameraName?: string): Promise<LiveStreamSource> {
    let camera: Camera | null;
    try {
      if (cameraName) {
        camera = await this.media.findCameraByName(cameraName);
      } else {
        const cameras = await this.media.listCameras();
        camera = await this.isReady('motion')
          ? cameras.find((candidate) => candidate.enabled && candidate.type === 'motion') ?? null
          : null;
        if (!camera && this.liveSources && await this.isReady('rtsp')) {
          for (const candidate of cameras) {
            if (candidate.enabled && await this.liveSources.isReady(candidate.id)) {
              camera = candidate;
              break;
            }
          }
        }
      }
      return await this.toSource(camera);
    } catch {
      throw new LiveStreamSourceUnavailableError();
    }
  }

  async resolveById(cameraId: string): Promise<LiveStreamSource> {
    let camera: Camera | null;
    try {
      camera = (await this.media.listCameras()).find(
        (candidate) => candidate.id === cameraId,
      ) ?? null;
      return await this.toSource(camera);
    } catch {
      throw new LiveStreamSourceUnavailableError();
    }
  }

  private async toSource(camera: Camera | null): Promise<LiveStreamSource> {
    if (!camera?.enabled) {
      throw new LiveStreamSourceUnavailableError();
    }

    if (this.liveSources && await this.liveSources.isReady(camera.id) && await this.isReady('rtsp')) {
      return { kind: 'rtsp', cameraId: camera.id, cameraName: camera.name };
    }

    if (camera.type !== 'motion' || !(await this.isReady('motion'))) throw new LiveStreamSourceUnavailableError();

    return {
      kind: 'motion-mjpeg',
      cameraId: camera.id,
      cameraName: camera.name,
      upstreamUrl: MOTION_MJPEG_UPSTREAM,
    };
  }

  private async isReady(name: 'motion' | 'rtsp'): Promise<boolean> {
    try {
      await this.availability?.requireReady(name);
      return true;
    } catch { return false; }
  }
}
