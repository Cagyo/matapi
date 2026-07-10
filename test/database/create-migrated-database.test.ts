import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  MigrationRunner,
} from '../../src/database/create-migrated-database';
import { AppDatabase } from '../../src/database/database.tokens';

describe('createMigratedDatabase', () => {
  it('passes the Drizzle database and migrations folder to the runner', () => {
    const sqlite = new Database(':memory:');
    const migrationsFolder = '/migrations';
    let receivedDatabase: AppDatabase | undefined;
    let receivedOptions: { migrationsFolder: string } | undefined;
    const runMigrations: MigrationRunner = (database, options) => {
      receivedDatabase = database;
      receivedOptions = options;
    };

    const database = createMigratedDatabase(
      sqlite,
      migrationsFolder,
      runMigrations,
    );

    expect(receivedDatabase).toBe(database);
    expect(receivedOptions).toEqual({ migrationsFolder });

    sqlite.close();
  });

  it('closes SQLite and propagates the original migration error', () => {
    const sqlite = new Database(':memory:');
    const migrationError = new Error('migration failed');
    const runMigrations: MigrationRunner = () => {
      throw migrationError;
    };
    let thrown: unknown;

    try {
      createMigratedDatabase(sqlite, '/migrations', runMigrations);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(migrationError);
    expect(sqlite.open).toBe(false);
  });
});
