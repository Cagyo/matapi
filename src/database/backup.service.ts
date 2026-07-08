import { Injectable, Inject, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQLITE } from './database.tokens';

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
    const tmp = `${target}.tmp`;
    try {
      await this.sqlite.backup(tmp);
      renameSync(tmp, target); // atomic within the same filesystem
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore — best-effort cleanup of the partial temp file
      }
      throw err;
    }
    this.logger.log(`Backup written to ${target}`);
    return target;
  }
}
