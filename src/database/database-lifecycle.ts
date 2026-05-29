import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE } from './database.module';

/**
 * Closes the SQLite connection on shutdown (spec 23 — Graceful Shutdown step
 * 7). `DatabaseModule` is global and initialised first, so its teardown runs
 * last — after sensors have flushed buffered writes.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycle.name);

  constructor(@Inject(SQLITE) private readonly sqlite: Database.Database) {}

  onApplicationShutdown(): void {
    try {
      this.sqlite.close();
      this.logger.log('SQLite connection closed');
    } catch (err) {
      this.logger.warn(`Failed to close SQLite: ${(err as Error).message}`);
    }
  }
}
