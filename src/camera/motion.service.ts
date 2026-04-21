import { Injectable, Logger } from '@nestjs/common';

/** Phase 1: control Motion daemon via systemd. Stub. */
@Injectable()
export class MotionService {
  private readonly logger = new Logger(MotionService.name);

  async start(): Promise<void> {
    this.logger.warn('MotionService.start: not implemented');
  }

  async stop(): Promise<void> {
    this.logger.warn('MotionService.stop: not implemented');
  }
}
