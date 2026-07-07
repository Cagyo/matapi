import { Injectable, Logger } from '@nestjs/common';
import { DriveAuthPort } from '../domain/ports/drive-auth.port';

/** Dev/test `DriveAuthPort`. Logs and succeeds. */
@Injectable()
export class StubDriveAuthAdapter implements DriveAuthPort {
  private readonly logger = new Logger(StubDriveAuthAdapter.name);

  async updateConfig(configSnippet: string): Promise<void> {
    this.logger.log(`[Stub] updateConfig called (${configSnippet.length} chars)`);
  }

  async restoreBackup(): Promise<void> {
    this.logger.log('[Stub] restoreBackup called');
  }
}
