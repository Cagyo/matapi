import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AppDatabase } from './database.tokens';
import * as schema from './schema';

export interface MigrationOptions {
  migrationsFolder: string;
}

export type MigrationRunner = (
  database: AppDatabase,
  options: MigrationOptions,
) => void;

function defaultMigrationRunner(
  database: AppDatabase,
  options: MigrationOptions,
): void {
  migrate(database, options);
}

export function createMigratedDatabase(
  sqlite: Database.Database,
  migrationsFolder: string,
  runMigrations: MigrationRunner = defaultMigrationRunner,
): AppDatabase {
  const database = drizzle(sqlite, { schema });

  try {
    runMigrations(database, { migrationsFolder });
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return database;
}
