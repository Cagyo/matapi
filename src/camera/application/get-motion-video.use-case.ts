import { Inject, Injectable } from '@nestjs/common';
import { EventNotFoundError } from '../domain/errors/event-not-found.error';
import { MediaFileUnavailableError } from '../domain/errors/media-file-unavailable.error';
import { MotionEvent } from '../domain/motion-event.entity';
import { MEDIA_FILE, MediaFilePort } from '../domain/ports/media-file.port';
import {
  MEDIA_REPOSITORY,
  MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import {
  ARCHIVE_VERIFICATION,
  type ArchiveVerificationPort,
} from '../../archive/application/ports/archive-verification.port';

/** Telegram's hard limit for bot-sent files. */
export const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024;

export type VideoDelivery =
  | { kind: 'local'; event: MotionEvent; path: string }
  | { kind: 'drive'; event: MotionEvent; webViewLink: string };

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
    @Inject(ARCHIVE_VERIFICATION) private readonly archive: ArchiveVerificationPort,
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
  ) {}

  async execute(eventId: number): Promise<VideoDelivery> {
    await this.availability?.requireReady('motion');
    const event = await this.media.findEventById(eventId);
    if (!event) throw new EventNotFoundError(eventId);

    const path = event.videoPath;
    const localAvailable =
      !!path && !event.localDeleted && (await this.files.exists(path));

    if (localAvailable) {
      const size = await this.files.sizeBytes(path);
      const tooLarge = size !== null && size > TELEGRAM_MAX_FILE_BYTES;
      if (tooLarge) {
        const webViewLink = await this.currentWebViewLink(event);
        if (webViewLink !== null) return { kind: 'drive', event, webViewLink };
      }
      return { kind: 'local', event, path };
    }

    const webViewLink = await this.currentWebViewLink(event);
    if (webViewLink !== null) return { kind: 'drive', event, webViewLink };
    throw new MediaFileUnavailableError(eventId);
  }

  private async currentWebViewLink(event: MotionEvent): Promise<string | null> {
    if (event.archiveArtifactId === null) return null;
    return (await this.archive.inspect(event.archiveArtifactId)).webViewLink;
  }
}
