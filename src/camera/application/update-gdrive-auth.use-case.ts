import { Inject, Injectable, Logger } from '@nestjs/common';
import { GdriveAuthFailedError } from '../domain/errors/gdrive-auth-failed.error';
import { GdriveNotInstalledError } from '../domain/errors/gdrive-not-installed.error';
import { GdriveStatusFailedError } from '../domain/errors/gdrive-status-failed.error';
import { DRIVE_AUTH, DriveAuthPort } from '../domain/ports/drive-auth.port';
import { DRIVE_STATUS, DriveQuota, DriveStatusPort } from '../domain/ports/drive-status.port';

@Injectable()
export class UpdateGdriveAuthUseCase {
  private readonly logger = new Logger(UpdateGdriveAuthUseCase.name);

  constructor(
    @Inject(DRIVE_AUTH) private readonly driveAuth: DriveAuthPort,
    @Inject(DRIVE_STATUS) private readonly driveStatus: DriveStatusPort,
  ) {}

  async execute(configSnippet: string): Promise<DriveQuota> {
    try {
      await this.driveAuth.updateConfig(configSnippet);
    } catch (err) {
      if (err instanceof GdriveNotInstalledError || err instanceof GdriveAuthFailedError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new GdriveAuthFailedError(reason);
    }

    try {
      return await this.driveStatus.about();
    } catch (err) {
      let reason = 'verification failed';
      if (err instanceof GdriveStatusFailedError) {
        reason = err.reason;
      } else if (err instanceof Error) {
        reason = err.message;
      }

      this.logger.warn(`Auth verification failed after config update: ${reason}. Restoring backup.`);
      try {
        await this.driveAuth.restoreBackup();
      } catch (restoreErr) {
        this.logger.error(
          `Failed to restore backup after auth verification failure: ${(restoreErr as Error).message}`,
          (restoreErr as Error).stack,
        );
      }

      throw new GdriveAuthFailedError(reason);
    }
  }
}
