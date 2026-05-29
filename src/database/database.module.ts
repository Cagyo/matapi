import { Global, Module, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { DatabaseLifecycle } from './database-lifecycle';
import { DatabaseRecoveryState } from './database-recovery.state';
import { openSqliteWithIntegrity } from './integrity';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export const DB = Symbol('DB');
export const SQLITE = Symbol('SQLITE');

@Global()
@Module({
  providers: [
    DatabaseRecoveryState,
    {
      provide: SQLITE,
      inject: [DatabaseRecoveryState],
      useFactory: (recoveryState: DatabaseRecoveryState) => {
        const dbPath = resolve(process.env.DATABASE_PATH || './data/dev.db');
        const logger = new Logger('DatabaseModule');

        const { sqlite, recovery } = openSqliteWithIntegrity(dbPath, logger);
        recoveryState.recovery = recovery;
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
    DatabaseLifecycle,
  ],
  exports: [DB, SQLITE, DatabaseRecoveryState],
})
export class DatabaseModule {}
