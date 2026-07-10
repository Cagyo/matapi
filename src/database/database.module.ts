import { Global, Module, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { createMigratedDatabase } from './create-migrated-database';
import { DatabaseLifecycle } from './database-lifecycle';
import { DatabaseRecoveryState } from './database-recovery.state';
import { openSqliteWithIntegrity } from './integrity';
import { AppDatabase, DB, SQLITE } from './database.tokens';

export * from './database.tokens';

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
      useFactory: (sqlite: Database.Database): AppDatabase =>
        createMigratedDatabase(sqlite, resolve('./migrations')),
    },
    DatabaseLifecycle,
  ],
  exports: [DB, SQLITE, DatabaseRecoveryState],
})
export class DatabaseModule {}
