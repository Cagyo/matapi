import Database from 'better-sqlite3';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AppDatabase } from '../../src/database/database.module';
import * as schema from '../../src/database/schema';

export type TestDatabase = BetterSQLite3Database<typeof schema>;

export interface TestDatabaseContext {
  sqlite: Database.Database;
  db: TestDatabase;
  appDb: AppDatabase;
  close(): void;
}

export function createTestDatabase(): TestDatabaseContext {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './migrations' });

  return {
    sqlite,
    db,
    appDb: db as AppDatabase,
    close: () => sqlite.close(),
  };
}