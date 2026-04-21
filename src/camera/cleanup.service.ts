import { Injectable, Logger } from '@nestjs/common';

/** Phase 1: local + remote retention/cleanup. Stub. */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  async run(): Promise<void> {
    this.logger.warn('CleanupService.run: not implemented');
  }
}
