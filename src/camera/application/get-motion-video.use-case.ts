import { Inject, Injectable } from '@nestjs/common';
import { EventNotFoundError } from '../domain/errors/event-not-found.error';
import { MediaFileUnavailableError } from '../domain/errors/media-file-unavailable.error';
import { MotionEvent } from '../domain/motion-event.entity';
import { MEDIA_FILE, MediaFilePort } from '../domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

/** Telegram's hard limit for bot-sent files. */
export const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024;

export type VideoDelivery =
  | { kind: 'local'; event: MotionEvent; path: string }
  | { kind: 'drive'; event: MotionEvent };

/**
 * `/camera video <id>` — spec 14.
 *
 * Decides how to deliver the clip: the local file when present and under
 * the Telegram size limit, otherwise the Google Drive link when the file
 * was uploaded. Compression is not implemented yet (deferred); oversized
 * clips fall back to Drive. Throws when no copy survives anywhere.
 */
@Injectable()
export class GetMotionVideoUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(MEDIA_FILE) private readonly files: MediaFilePort,
  ) {}

  async execute(eventId: number): Promise<VideoDelivery> {
    const event = await this.media.findEventById(eventId);
    if (!event) throw new EventNotFoundError(eventId);

    const path = event.videoPath;
    const localAvailable =
      !!path && !event.localDeleted && (await this.files.exists(path));

    if (localAvailable) {
      const size = await this.files.sizeBytes(path);
      const tooLarge = size !== null && size > TELEGRAM_MAX_FILE_BYTES;
      if (tooLarge && event.gdriveFileId) {
        return { kind: 'drive', event };
      }
      return { kind: 'local', event, path };
    }

    if (event.gdriveFileId) return { kind: 'drive', event };
    throw new MediaFileUnavailableError(eventId);
  }
}
