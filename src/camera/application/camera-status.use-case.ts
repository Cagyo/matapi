import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_FILE, MediaFilePort } from '../domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import {
  MOTION_CONTROL,
  MotionControlPort,
} from '../domain/ports/motion-control.port';

export interface CameraStatusResult {
  running: boolean;
  lastEventAt: Date | null;
  localStorageBytes: number | null;
  eventsToday: number;
}

/** `/camera status` — spec 14. Daemon state, last event, storage, counts. */
@Injectable()
export class CameraStatusUseCase {
  constructor(
    @Inject(MOTION_CONTROL) private readonly motion: MotionControlPort,
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_FILE) private readonly files: MediaFilePort,
  ) {}

  async execute(): Promise<CameraStatusResult> {
    const now = new Date();
    const [running, lastEvent, localStorageBytes, eventsToday] =
      await Promise.all([
        this.motion.isActive(),
        this.media.lastEvent(),
        this.files.localUsageBytes(),
        this.media.countEventsOnDay(now),
      ]);

    return {
      running,
      lastEventAt: lastEvent?.startedAt ?? null,
      localStorageBytes,
      eventsToday,
    };
  }
}
