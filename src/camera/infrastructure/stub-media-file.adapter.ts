import { Injectable } from '@nestjs/common';
import { MediaFilePort } from '../domain/ports/media-file.port';

/**
 * Dev/test `MediaFilePort`. Reports recorded media as present and small so
 * `/camera video`/`photo` resolve to the local-delivery branch locally.
 */
@Injectable()
export class StubMediaFileAdapter implements MediaFilePort {
  async exists(path: string): Promise<boolean> {
    return !!path;
  }

  async sizeBytes(): Promise<number | null> {
    return 1024 * 1024; // 1 MB
  }

  async localUsageBytes(): Promise<number | null> {
    return null;
  }
}
