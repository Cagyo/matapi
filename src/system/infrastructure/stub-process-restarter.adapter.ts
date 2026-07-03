import { Injectable, Logger } from '@nestjs/common';
import { ProcessRestarterPort } from '../domain/ports/process-restarter.port';

/**
 * Dev/stub `ProcessRestarterPort` implementation.
 *
 * Avoids spawning `pm2 restart` on dev hosts and during E2E tests.
 */
@Injectable()
export class StubProcessRestarter implements ProcessRestarterPort {
  private readonly logger = new Logger(StubProcessRestarter.name);

  async restart(): Promise<void> {
    this.logger.log('StubProcessRestarter restart() called (skipping pm2 restart in dev mode)');
  }
}
