import { Inject, Injectable } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import { CameraNotFoundError } from '../domain/errors/camera-not-found.error';
import { MotionNotRunningError } from '../domain/errors/motion-not-running.error';
import { NoCamerasConfiguredError } from '../domain/errors/no-cameras-configured.error';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';
import { SNAPSHOT, SnapshotPort } from '../domain/ports/snapshot.port';

export interface SnapshotResult {
  buffer: Buffer;
  cameraName: string;
  takenAt: Date;
}

/**
 * `/camera snapshot [name]` — spec 14.
 *
 * Resolves the target camera (named, or the first configured camera),
 * verifies the Motion daemon is running, then grabs a still via
 * `SnapshotPort`. The 2-second cache lives inside the adapter.
 */
@Injectable()
export class GetSnapshotUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(SNAPSHOT) private readonly snapshot: SnapshotPort,
  ) {}

  async execute(cameraName?: string): Promise<SnapshotResult> {
    const camera = await this.resolveCamera(cameraName);

    if (!(await this.motion.isActive())) {
      throw new MotionNotRunningError();
    }

    const buffer = await this.snapshot.grab(camera.id, camera.name);
    return { buffer, cameraName: camera.name, takenAt: new Date() };
  }

  private async resolveCamera(cameraName?: string): Promise<Camera> {
    if (cameraName) {
      const camera = await this.media.findCameraByName(cameraName);
      if (!camera) throw new CameraNotFoundError(cameraName);
      return camera;
    }

    const cameras = await this.media.listCameras();
    if (cameras.length === 0) throw new NoCamerasConfiguredError();
    return cameras[0];
  }
}
