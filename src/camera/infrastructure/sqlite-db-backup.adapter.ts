import { Inject, Injectable, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQLITE } from '../../database/database.module';
import { DbBackupPort } from '../domain/ports/db-backup.port';

/**
 * Production `DbBackupPort` using the SQLite Online Backup API (spec 21), so
 * the daily Drive backup never blocks concurrent reads/writes. Writes to
 * `BACKUP_LOCAL_PATH`.
 */
@Injectable()
export class SqliteDbBackupAdapter implements DbBackupPort {
  private readonly logger = new Logger(SqliteDbBackupAdapter.name);

  constructor(@Inject(SQLITE) private readonly sqlite: Database.Database) {}

  async createLocalBackup(): Promise<string> {
    const target = resolve(process.env.BACKUP_LOCAL_PATH || './data/backup.db');
    mkdirSync(dirname(target), { recursive: true });
    await this.sqlite.backup(target);
    this.logger.log(`Local DB backup written to ${target}`);
    return target;
  }
}
