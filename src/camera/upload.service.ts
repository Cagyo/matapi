import { Injectable, Logger } from '@nestjs/common';

/** Phase 1: rclone upload to Google Drive. Stub. */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  async upload(_path: string): Promise<void> {
    this.logger.warn('UploadService.upload: not implemented');
  }
}
