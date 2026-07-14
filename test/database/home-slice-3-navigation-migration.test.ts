import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/database/schema';
import { DrizzleHomeActionRepository } from '../../src/telegram/infrastructure/drizzle-home-action.repository';
import { DrizzleHomeSessionStore } from '../../src/telegram/infrastructure/drizzle-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = new Date('2030-01-01T00:01:00.000Z');
const TOKEN = '1234567890abcdef';

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

  it('upgrades Slice 2 sessions and exposes receipt transitions through their Drizzle adapters', async () => {
    for (const filename of ['migrations/0000_init.sql', 'migrations/0001_tiny_ser_duncan.sql', 'migrations/0002_petite_mister_sinister.sql', migrationWithSuffix('notification_safety_foundation'), migrationWithSuffix('authoritative_home')]) apply(sqlite, filename);
    sqlite.prepare('INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)').run(100, 'User', 'user', 'en');
    sqlite.prepare('INSERT INTO user_sensor_mutes (user_id, sensor_id) VALUES (?, ?)').run(100, 'legacy-sensor-id');
    sqlite.prepare(`INSERT INTO home_sessions (user_id, chat_id, active_message_id, active_token, active_revision, active_view, active_sensor_page, active_checking, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(100, 200, 300, TOKEN, 1, 'sensors', 0, 1, NOW.getTime() / 1000);

    apply(sqlite, migrationWithSuffix('home_slice_3_navigation'));

    const db = drizzle(sqlite, { schema });
    const sessions = new DrizzleHomeSessionStore(db);
    await expect(sessions.validate({ userId: 100, chatId: 200, messageId: 300, token: TOKEN, revision: 1, now: NOW }))
      .resolves.toEqual({
        kind: 'accepted',
        active: { userId: 100, chatId: 200, messageId: 300, token: TOKEN, revision: 1 },
        view: { kind: 'sensors', page: 0, checking: true },
      });
    expect(sqlite.prepare('SELECT sensor_id AS sensorId FROM user_sensor_mutes WHERE user_id = ?').get(100)).toEqual({ sensorId: 'legacy-sensor-id' });

    const receipts = new DrizzleHomeActionRepository(db);
    await receipts.create({ id: 'abcdef1234567890', userId: 100, chatId: 200, kind: 'cleanup-confirmation', sessionToken: TOKEN, status: 'pending', expiresAt: LATER, payload: {} });
    const claimed = await receipts.claimExternal({ userId: 100, chatId: 200, kind: 'cleanup-confirmation', token: TOKEN, id: 'abcdef1234567890', now: NOW });
    if (claimed.kind !== 'claimed') throw new Error('expected upgraded receipt to be claimed');
    await receipts.finishExternal({ action: claimed.action, outcome: 'completed', now: NOW });
    await expect(receipts.claimExternal({ userId: 100, chatId: 200, kind: 'cleanup-confirmation', token: TOKEN, id: 'abcdef1234567890', now: NOW }))
      .resolves.toEqual({ kind: 'terminal' });
  });
});
