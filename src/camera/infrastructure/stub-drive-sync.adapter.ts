import { Injectable, Logger } from '@nestjs/common';
import { DriveSyncPort } from '../domain/ports/drive-sync.port';

/**
 * Dev/test `DriveSyncPort`. Logs intent and succeeds without touching rclone,
 * so the upload/cleanup loops can run on a dev box without Google Drive.
 */
@Injectable()
export class StubDriveSyncAdapter implements DriveSyncPort {
  private readonly logger = new Logger(StubDriveSyncAdapter.name);

  async copyMotionFiles(): Promise<void> {
    this.logger.debug('copyMotionFiles (stub) — no-op');
  }

  async pruneMotionFiles(minAgeDays: number): Promise<void> {
    this.logger.debug(`pruneMotionFiles(${minAgeDays}) (stub) — no-op`);
  }

  async uploadBackup(localPath: string, remoteName: string): Promise<void> {
    this.logger.debug(`uploadBackup(${localPath} -> ${remoteName}) (stub) — no-op`);
  }

  async pruneBackups(minAgeDays: number): Promise<void> {
    this.logger.debug(`pruneBackups(${minAgeDays}) (stub) — no-op`);
  }
}
