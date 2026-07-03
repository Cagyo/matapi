import { Injectable, Logger } from '@nestjs/common';
import { OtaPort, UpdateCheck } from '../domain/ports/ota.port';

/**
 * Dev/stub `OtaPort` implementation.
 *
 * Avoids running git fetch, shell scripts, or modifying lockfiles on dev hosts
 * and during E2E tests.
 */
@Injectable()
export class StubOtaAdapter implements OtaPort {
  private readonly logger = new Logger(StubOtaAdapter.name);
  private locked = false;

  async isLocked(): Promise<boolean> {
    return this.locked;
  }

  async checkForUpdates(): Promise<UpdateCheck> {
    this.logger.debug('StubOtaAdapter checkForUpdates() called');
    return {
      hasUpdates: false,
      localCommit: 'dev-mock-commit',
      remoteCommit: 'dev-mock-commit',
    };
  }

  async startUpdate(): Promise<void> {
    this.logger.log('StubOtaAdapter startUpdate() called (simulating OTA update)');
  }

  async startRollback(): Promise<void> {
    this.logger.log('StubOtaAdapter startRollback() called (simulating OTA rollback)');
  }
}
