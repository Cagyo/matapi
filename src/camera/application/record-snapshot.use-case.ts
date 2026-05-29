import { Inject, Injectable, Logger } from '@nestjs/common';
import { MEDIA_WRITER, MediaWriterPort } from '../domain/ports/media-writer.port';

/**
 * Records a saved snapshot (spec 20). Invoked by Motion's `on_picture_save`
 * hook, which provides only the file path (no camera). The snapshot is
 * attached to the most recent open event globally.
 */
@Injectable()
export class RecordSnapshotUseCase {
  private readonly logger = new Logger(RecordSnapshotUseCase.name);

  constructor(
    @Inject(MEDIA_WRITER) private readonly writer: MediaWriterPort,
  ) {}

  async execute(snapshotPath: string): Promise<void> {
    const updated = await this.writer.setSnapshotForLatestOpenEvent(snapshotPath);
    if (!updated) {
      this.logger.warn(
        `Snapshot ${snapshotPath} saved with no open event — not linked`,
      );
    }
  }
}
