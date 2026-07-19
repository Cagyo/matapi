import "dotenv/config";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { createMigratedDatabase } from "../../database/create-migrated-database";

export interface RuntimeMigrationOptions {
  databasePath: string;
  migrationsFolder: string;
}

export interface RuntimeMigrationDependencies {
  openDatabase(path: string): Database.Database;
  migrateDatabase(sqlite: Database.Database, migrationsFolder: string): void;
}

const DEFAULT_DEPENDENCIES: RuntimeMigrationDependencies = {
  openDatabase: (path) => new Database(path),
  migrateDatabase: (sqlite, migrationsFolder) => {
    createMigratedDatabase(sqlite, migrationsFolder);
  },
};

export function runRuntimeMigrations(
  options: RuntimeMigrationOptions = {
    databasePath: resolve(process.env.DATABASE_PATH || "./data/dev.db"),
    migrationsFolder: resolve("./migrations"),
  },
  dependencies: RuntimeMigrationDependencies = DEFAULT_DEPENDENCIES,
): void {
  const sqlite = dependencies.openDatabase(options.databasePath);
  try {
    dependencies.migrateDatabase(sqlite, options.migrationsFolder);
  } finally {
    if (sqlite.open) sqlite.close();
  }
}

if (require.main === module) runRuntimeMigrations();
