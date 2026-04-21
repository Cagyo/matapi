import { Injectable, Inject, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQLITE } from './database.module';

/**
 * SQLite Online Backup wrapper. Scheduled via @nestjs/schedule in higher-level
 * modules; this service exposes the `run()` method only.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(@Inject(SQLITE) private readonly sqlite: Database.Database) {}

  async run(): Promise<string> {
    const target = resolve(process.env.BACKUP_LOCAL_PATH || './data/backup.db');
    mkdirSync(dirname(target), { recursive: true });
    await this.sqlite.backup(target);
    this.logger.log(`Backup written to ${target}`);
    return target;
  }
}
