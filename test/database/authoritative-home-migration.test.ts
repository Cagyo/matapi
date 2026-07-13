import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function migrationWithSuffix(suffix: string): string {
  const filename = readdirSync(resolve('migrations')).find((entry) => entry.endsWith(`_${suffix}.sql`));
  if (!filename) throw new Error(`Generated migration ending in _${suffix}.sql was not found`);
  return `migrations/${filename}`;
}

function executeGeneratedMigration(sqlite: Database.Database, filename: string): void {
  const sql = readFileSync(resolve(filename), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('authoritative Home migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  it('preserves user notification state and creates writable foreign-key-safe Home sessions', () => {
    executeGeneratedMigration(sqlite, 'migrations/0000_init.sql');
    executeGeneratedMigration(sqlite, 'migrations/0001_tiny_ser_duncan.sql');
    executeGeneratedMigration(sqlite, 'migrations/0002_petite_mister_sinister.sql');
    executeGeneratedMigration(sqlite, migrationWithSuffix('notification_safety_foundation'));
    sqlite.prepare(
      `INSERT INTO users
         (telegram_id, name, role, locale, muted, non_critical_paused_until, notification_pause_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1001, 'Timed pause user', 'user', 'en', 0, 1_893_456_000, 4);

    executeGeneratedMigration(sqlite, migrationWithSuffix('authoritative_home'));

    expect(sqlite.prepare(
      `SELECT muted, non_critical_paused_until AS pausedUntil,
              notification_pause_revision AS revision
       FROM users WHERE telegram_id = ?`,
    ).get(1001)).toEqual({ muted: 0, pausedUntil: 1_893_456_000, revision: 4 });

    expect(() => sqlite.prepare(
      `INSERT INTO home_sessions
       (user_id, chat_id, active_message_id, active_token, active_revision,
        active_view, active_sensor_page, active_checking, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1001, 2001, 3001, 'token-a', 1, 'sensors', 2, 1, 1_893_452_400)).not.toThrow();

    expect(() => sqlite.prepare(
      `INSERT INTO home_sessions (user_id, chat_id, updated_at) VALUES (?, ?, ?)`,
    ).run(9999, 2002, 1_893_452_400)).toThrow();
  });
});
