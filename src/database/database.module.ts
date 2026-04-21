import { Global, Module, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export const DB = Symbol('DB');
export const SQLITE = Symbol('SQLITE');

@Global()
@Module({
  providers: [
    {
      provide: SQLITE,
      useFactory: () => {
        const dbPath = resolve(process.env.DATABASE_PATH || './data/dev.db');
        mkdirSync(dirname(dbPath), { recursive: true });

        const sqlite = new Database(dbPath);
        sqlite.pragma('journal_mode = WAL');
        sqlite.pragma('synchronous = NORMAL');
        sqlite.pragma('busy_timeout = 5000');
        sqlite.pragma('foreign_keys = ON');
        return sqlite;
      },
    },
    {
      provide: DB,
      inject: [SQLITE],
      useFactory: (sqlite: Database.Database): AppDatabase => {
        const db = drizzle(sqlite, { schema });

        try {
          migrate(db, { migrationsFolder: resolve('./migrations') });
        } catch (err) {
          new Logger('DatabaseModule').warn(
            `Migrations skipped or failed: ${(err as Error).message}`,
          );
        }
        return db;
      },
    },
  ],
  exports: [DB, SQLITE],
})
export class DatabaseModule {}
