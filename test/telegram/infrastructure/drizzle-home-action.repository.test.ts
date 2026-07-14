import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { DrizzleHomeActionRepository } from '../../../src/telegram/infrastructure/drizzle-home-action.repository';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = new Date('2030-01-01T00:01:00.000Z');

describe('DrizzleHomeActionRepository', () => {
  let sqlite: Database.Database;
  let repository: DrizzleHomeActionRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    sqlite.prepare('INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)').run(100, 'User', 'user', 'en');
    repository = new DrizzleHomeActionRepository(db);
  });

  afterEach(() => sqlite.close());

  it('persists replacement, guarded claim, and finish across adapter restarts', async () => {
    await repository.create({ id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'restart-confirmation', sessionToken: 'token-a', status: 'pending', expiresAt: LATER, payload: {} });
    const result = await repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'restart-confirmation', id: '1234567890abcdef', now: NOW });
    if (result.kind !== 'claimed') throw new Error('expected claimed action');
    await repository.finishExternal({ action: result.action, outcome: 'failed', now: NOW });
    const restarted = new DrizzleHomeActionRepository(drizzle(sqlite, { schema }));
    await expect(restarted.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'restart-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'terminal' });
  });

  it('fails closed for a persisted mismatched kind, status, token, or payload', async () => {
    sqlite.prepare(`INSERT INTO home_action_receipts (user_id, chat_id, kind, id, session_token, status, payload, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(100, 200, 'cleanup-confirmation', '1234567890abcdef', null, 'pending', '{}', LATER.getTime() / 1000, NOW.getTime() / 1000);
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'superseded' });
  });

  it('atomically confirms a pause with its foundation receipt and Home undo', async () => {
    await repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', payload: { hours: 1 },
      expiresAt: new Date(NOW.getTime() + 120_000),
    });

    await expect(repository.confirmPause({
      userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours: 1, now: NOW,
    })).resolves.toEqual({ kind: 'applied', expectedRevision: 1 });
    expect(sqlite.prepare('SELECT notification_pause_revision FROM users WHERE telegram_id = 100').get()).toEqual({ notification_pause_revision: 1 });
    expect(sqlite.prepare('SELECT count(*) AS count FROM notification_pause_receipts WHERE user_id = 100').get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT status FROM home_action_receipts WHERE kind = 'pause-confirmation'").get()).toEqual({ status: 'completed' });
    expect(sqlite.prepare("SELECT status FROM home_action_receipts WHERE kind = 'undo-non-critical-pause'").get()).toEqual({ status: 'pending' });
  });

  it.each([1, 4, 8] as const)('allows the %ih pause Undo immediately before its deadline and rejects it at the deadline', async (hours) => {
    const deadline = new Date(NOW.getTime() + hours * 3_600_000);
    await repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', payload: { hours }, expiresAt: new Date(NOW.getTime() + 120_000),
    });
    await repository.confirmPause({ userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours, now: NOW });
    await expect(repository.undoPause({ userId: 100, chatId: 200, id: '1234567890abcdef', now: new Date(deadline.getTime() - 1) }))
      .resolves.toEqual({ kind: 'applied' });

    await repository.createPauseConfirmation({
      id: 'abcdef1234567890', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', payload: { hours }, expiresAt: new Date(NOW.getTime() + 120_000),
    });
    await repository.confirmPause({ userId: 100, chatId: 200, token: 'token-a', id: 'abcdef1234567890', hours, now: NOW });
    await expect(repository.undoPause({ userId: 100, chatId: 200, id: 'abcdef1234567890', now: deadline }))
      .resolves.toEqual({ kind: 'expired' });
    expect(sqlite.prepare('SELECT non_critical_paused_until AS pausedUntil FROM users WHERE telegram_id = 100').get()).toEqual({ pausedUntil: deadline.getTime() / 1_000 });
  });
});
