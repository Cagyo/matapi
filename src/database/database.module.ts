import { Global, Module, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { createMigratedDatabase } from './create-migrated-database';
import { DatabaseLifecycle } from './database-lifecycle';
import { DatabaseRecoveryState } from './database-recovery.state';
import { openSqliteWithIntegrity } from './integrity';
import { AppDatabase, DB, SQLITE } from './database.tokens';
import { DATABASE_BACKUP_SNAPSHOT, type DatabaseBackupSnapshotPort } from './application/ports/database-backup-snapshot.port';
import { BetterSqlite3BackupSnapshotAdapter } from './infrastructure/better-sqlite3-backup-snapshot.adapter';
import { InMemoryDatabaseBackupSnapshotAdapter } from './infrastructure/in-memory-database-backup-snapshot.adapter';

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
    {
      provide: DATABASE_BACKUP_SNAPSHOT,
      inject: [SQLITE],
      useFactory: (sqlite: Database.Database): DatabaseBackupSnapshotPort =>
        process.env.NODE_ENV === 'test'
          ? new InMemoryDatabaseBackupSnapshotAdapter()
          : new BetterSqlite3BackupSnapshotAdapter(sqlite),
    },
    DatabaseLifecycle,
  ],
  exports: [DB, SQLITE, DatabaseRecoveryState, DATABASE_BACKUP_SNAPSHOT],
})
export class DatabaseModule {}
