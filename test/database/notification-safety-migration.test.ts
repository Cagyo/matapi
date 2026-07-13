import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function executeGeneratedMigration(
  sqlite: Database.Database,
  relativePath: string,
): void {
  const sql = readFileSync(resolve(relativePath), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('notification safety migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // Match production (integrity.ts): without this, SQLite ignores the
    // receipt table's user_id → users(telegram_id) foreign key entirely.
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  it('preserves a legacy indefinite mute while adding safe pause defaults', () => {
    executeGeneratedMigration(sqlite, 'migrations/0000_init.sql');
    executeGeneratedMigration(sqlite, 'migrations/0001_tiny_ser_duncan.sql');
    executeGeneratedMigration(sqlite, 'migrations/0002_petite_mister_sinister.sql');
    sqlite
      .prepare(
        `INSERT INTO users (telegram_id, name, role, locale, muted)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(1001, 'Legacy user', 'user', 'en', 1);

    executeGeneratedMigration(
      sqlite,
      'migrations/0003_notification_safety_foundation.sql',
    );

    const user = sqlite
      .prepare(
        `SELECT muted,
                non_critical_paused_until AS pausedUntil,
                notification_pause_revision AS revision
         FROM users WHERE telegram_id = ?`,
      )
      .get(1001) as { muted: number; pausedUntil: number | null; revision: number };

    expect(user).toEqual({ muted: 1, pausedUntil: null, revision: 0 });
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO notification_pause_receipts
             (user_id, previous_paused_until, applied_paused_until,
              expected_revision, expires_at, created_at)
           VALUES (?, NULL, ?, ?, ?, ?)`,
        )
        .run(1001, 1_893_456_000, 1, 1_893_456_000, 1_893_452_400),
    ).not.toThrow();

    // With FKs enforced, a receipt for a non-existent user is rejected —
    // proving the constraint is real, not merely declared.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO notification_pause_receipts
             (user_id, previous_paused_until, applied_paused_until,
              expected_revision, expires_at, created_at)
           VALUES (?, NULL, ?, ?, ?, ?)`,
        )
        .run(9999, 1_893_456_000, 1, 1_893_456_000, 1_893_452_400),
    ).toThrow();
  });
});
