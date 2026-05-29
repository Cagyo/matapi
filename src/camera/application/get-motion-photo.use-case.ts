import { Inject, Injectable } from '@nestjs/common';
import { EventNotFoundError } from '../domain/errors/event-not-found.error';
import { MediaFileUnavailableError } from '../domain/errors/media-file-unavailable.error';
import { NoSnapshotForEventError } from '../domain/errors/no-snapshot-for-event.error';
import { MotionEvent } from '../domain/motion-event.entity';
import { MEDIA_FILE, MediaFilePort } from '../domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

export interface PhotoResult {
  event: MotionEvent;
  path: string;
}

/** `/camera photo <id>` — spec 14. Sends the event's saved snapshot. */
@Injectable()
export class GetMotionPhotoUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_FILE) private readonly files: MediaFilePort,
  ) {}

  async execute(eventId: number): Promise<PhotoResult> {
    const event = await this.media.findEventById(eventId);
    if (!event) throw new EventNotFoundError(eventId);

    const path = event.snapshotPath;
    if (!path) throw new NoSnapshotForEventError(eventId);
    if (!(await this.files.exists(path))) {
      throw new MediaFileUnavailableError(eventId);
    }

    return { event, path };
  }
}
