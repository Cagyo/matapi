import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { DbBackupPort } from '../domain/ports/db-backup.port';

/** Dev/test `DbBackupPort`. Returns the would-be backup path without writing. */
@Injectable()
export class StubDbBackupAdapter implements DbBackupPort {
  async createLocalBackup(): Promise<string> {
    return resolve(process.env.BACKUP_LOCAL_PATH || './data/backup.db');
  }
}
