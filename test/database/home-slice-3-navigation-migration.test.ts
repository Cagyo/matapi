import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function migrationWithSuffix(suffix: string): string {
  const filename = readdirSync(resolve('migrations')).find((entry) => entry.endsWith(`_${suffix}.sql`));
  if (!filename) throw new Error(`Generated migration ending in _${suffix}.sql was not found`);
  return `migrations/${filename}`;
}

function apply(sqlite: Database.Database, filename: string): void {
  for (const statement of readFileSync(resolve(filename), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('Home Slice 3 navigation migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  it('preserves Slice 2 sessions and unprefixed legacy mutes while adding bounded receipt storage', () => {
    for (const filename of ['migrations/0000_init.sql', 'migrations/0001_tiny_ser_duncan.sql', 'migrations/0002_petite_mister_sinister.sql', migrationWithSuffix('notification_safety_foundation'), migrationWithSuffix('authoritative_home')]) apply(sqlite, filename);
    sqlite.prepare('INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)').run(100, 'User', 'user', 'en');
    sqlite.prepare('INSERT INTO user_sensor_mutes (user_id, sensor_id) VALUES (?, ?)').run(100, 'legacy-sensor-id');
    sqlite.prepare(`INSERT INTO home_sessions (user_id, chat_id, active_message_id, active_token, active_revision, active_view, active_sensor_page, active_checking, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(100, 200, 300, 'token-a', 1, 'sensors', 2, 1, 1_893_456_000);

    apply(sqlite, migrationWithSuffix('home_slice_3_navigation'));

    expect(sqlite.prepare('SELECT active_view AS view, active_sensor_page AS page, active_checking AS checking, active_view_payload AS payload FROM home_sessions').get())
      .toEqual({ view: 'sensors', page: 2, checking: 1, payload: null });
    expect(sqlite.prepare('SELECT sensor_id AS sensorId FROM user_sensor_mutes WHERE user_id = ?').get(100)).toEqual({ sensorId: 'legacy-sensor-id' });
    sqlite.prepare(`INSERT INTO home_action_receipts (user_id, chat_id, kind, id, session_token, status, payload, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(100, 200, 'cleanup-confirmation', '1234567890abcdef', 'token-a', 'pending', '{}', 1_893_456_060, 1_893_456_000);
    sqlite.prepare(`UPDATE home_action_receipts SET status = 'executing' WHERE user_id = ? AND chat_id = ? AND kind = ?`).run(100, 200, 'cleanup-confirmation');
    sqlite.prepare(`UPDATE home_action_receipts SET status = 'completed' WHERE user_id = ? AND chat_id = ? AND kind = ?`).run(100, 200, 'cleanup-confirmation');
    expect(sqlite.prepare('SELECT status FROM home_action_receipts').get()).toEqual({ status: 'completed' });
  });
});
