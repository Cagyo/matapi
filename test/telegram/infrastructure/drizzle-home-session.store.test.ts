import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../../../src/database/database.tokens';
import * as schema from '../../../src/database/schema';
import type { HomeIdentity, HomeReservation, HomeView } from '../../../src/telegram/domain/home-session';
import { DrizzleHomeSessionStore } from '../../../src/telegram/infrastructure/drizzle-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const HOME: HomeView = { kind: 'home', checking: false };
const SENSORS: HomeView = { kind: 'sensors', page: 2, checking: true };
const VALID_TOKEN = '1234567890abcdef';
const SECOND_TOKEN = 'abcdef1234567890';

function later(milliseconds = 60_000): Date {
  return new Date(NOW.getTime() + milliseconds);
}

function identity(overrides: Partial<HomeIdentity> = {}): HomeIdentity {
  return { userId: 100, chatId: 200, messageId: 300, token: VALID_TOKEN, revision: 1, ...overrides };
}

async function openActive(store: DrizzleHomeSessionStore, overrides: Partial<Pick<HomeIdentity, 'userId' | 'chatId' | 'messageId' | 'token'>> = {}): Promise<HomeIdentity> {
  const reservation = await store.reserveNew({
    userId: overrides.userId ?? 100,
    chatId: overrides.chatId ?? 200,
    token: overrides.token ?? VALID_TOKEN,
    view: HOME,
    now: NOW,
    expiresAt: later(),
  });
  const result = await store.promoteNew(reservation, overrides.messageId ?? 300, NOW);
  if (result.kind !== 'promoted') throw new Error('expected active Home');
  return result.active;
}

async function holdImmediateLock(databasePath: string): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const Database = require('better-sqlite3');
      const { parentPort, workerData } = require('node:worker_threads');
      const sqlite = new Database(workerData);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
      sqlite.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => {
        sqlite.exec('COMMIT');
        sqlite.close();
        parentPort.postMessage('released');
      }, 50);
    `, { eval: true, workerData: databasePath });
    worker.once('message', (message) => {
      if (message === 'locked') resolve(worker);
    });
    worker.once('error', reject);
  });
}

function configureContentionConnection(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
}

describe('DrizzleHomeSessionStore', () => {
  it('round-trips every Slice 3 view through reserve, promote, validate, and adapter restart', async () => {
    const targets = Array.from({ length: 8 }, (_, index) => ({
      kind: index % 2 === 0 ? 'sensor' as const : 'camera' as const,
      id: `a0a0a0a0-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    const views: readonly HomeView[] = [
      { kind: 'notifications' },
      { kind: 'notification-targets', page: 0, targets },
      { kind: 'notification-target', page: 0, target: targets[0] },
      { kind: 'pause-duration' },
      { kind: 'pause-confirmation', hours: 1, receiptId: VALID_TOKEN },
      { kind: 'more' }, { kind: 'history' }, { kind: 'admin-tools' },
      { kind: 'admin-sensor-setup' }, { kind: 'admin-storage' }, { kind: 'admin-system' },
      { kind: 'confirmation', action: 'restart', receiptId: SECOND_TOKEN },
      { kind: 'cleanup-result', outcome: 'failed', threshold: null },
    ];
    const restarted = new DrizzleHomeSessionStore(drizzle(sqlite, { schema }));
    for (const [index, view] of views.entries()) {
      const userId = 100;
      const chatId = 1_000 + index;
      const token = index % 2 === 0 ? VALID_TOKEN : SECOND_TOKEN;
      const reservation = await store.reserveNew({ userId, chatId, token, view, now: NOW, expiresAt: later() });
      const promoted = await store.promoteNew(reservation, 500 + index, NOW);
      if (promoted.kind !== 'promoted') throw new Error('expected active Home');
      await expect(store.validate({ ...promoted.active, now: NOW })).resolves.toEqual({ kind: 'accepted', active: promoted.active, view });
      await expect(restarted.validate({ ...promoted.active, now: NOW })).resolves.toEqual({ kind: 'accepted', active: promoted.active, view });
    }
  });

  it('fails closed for malformed persisted identity, reservation, and raw boolean values', async () => {
    const insert = sqlite.prepare(`INSERT INTO home_sessions (
      user_id, chat_id, active_message_id, active_token, active_revision, active_view,
      active_sensor_page, active_view_payload, active_checking, pending_kind,
      pending_message_id, pending_token, pending_revision, pending_view,
      pending_sensor_page, pending_view_payload, pending_checking, pending_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const base = [100, 200, 300, VALID_TOKEN, 1, 'sensors', 0, null, 1, null, null, null, null, null, null, null, null, null, NOW.getTime() / 1000];
    insert.run(...base);
    await expect(store.validate({ ...identity(), now: NOW })).resolves.toMatchObject({ kind: 'accepted', view: { kind: 'sensors', page: 0, checking: true } });

    for (const [chatId, token, revision, messageId, checking] of [
      [201, 'too-short', 1, 300, 1],
      [202, VALID_TOKEN, 0, 300, 1],
      [203, VALID_TOKEN, 1, 0, 1],
      [204, VALID_TOKEN, 1, 300, 2],
    ] as const) {
      insert.run(100, chatId, messageId, token, revision, 'home', null, null, checking, null, null, null, null, null, null, null, null, null, NOW.getTime() / 1000);
      await expect(store.validate({ ...identity({ chatId, token, revision, messageId }), now: NOW })).resolves.toEqual({ kind: 'closed' });
    }

    insert.run(100, 205, null, null, null, null, null, null, null, 'new', 301, VALID_TOKEN, 1, 'home', null, null, 1, later().getTime() / 1000, NOW.getTime() / 1000);
    await expect(store.validate({ ...identity({ chatId: 205 }), now: NOW })).resolves.toEqual({ kind: 'closed' });

    insert.run(100, 206, 300, VALID_TOKEN, 1, 'home', null, null, 1, 'edit', 300, VALID_TOKEN, 2, 'home', null, null, 2, later().getTime() / 1000, NOW.getTime() / 1000);
    await expect(store.validate({ ...identity({ chatId: 206 }), now: NOW })).resolves.toEqual({ kind: 'closed' });
  });

  it('persists a typed Slice 3 notification-target view over an adapter restart', async () => {
    const view: HomeView = {
      kind: 'notification-targets', page: 1,
      targets: [
        { kind: 'sensor', id: 'a0a0a0a0-0000-4000-8000-000000000001' },
        { kind: 'camera', id: 'a0a0a0a0-0000-4000-8000-000000000002' },
      ],
    };
    const reservation = await store.reserveNew({ userId: 100, chatId: 200, token: VALID_TOKEN, view, now: NOW, expiresAt: later() });
    const promoted = await store.promoteNew(reservation, 300, NOW);
    if (promoted.kind !== 'promoted') throw new Error('expected active Home');
    const restarted = new DrizzleHomeSessionStore(drizzle(sqlite, { schema }));
    await expect(restarted.validate({ ...promoted.active, now: NOW })).resolves.toEqual({ kind: 'accepted', active: promoted.active, view });
  });

  let sqlite: Database.Database;
  let db: AppDatabase;
  let store: DrizzleHomeSessionStore;
  let databaseDirectory: string;
  let databasePath: string;

  beforeEach(() => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'home-session-store-'));
    databasePath = join(databaseDirectory, 'home.db');
    sqlite = new Database(databasePath);
    configureContentionConnection(sqlite);
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    sqlite.prepare(`INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)`).run(100, 'User', 'user', 'en');
    store = new DrizzleHomeSessionStore(db);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(databaseDirectory, { recursive: true, force: true });
  });

  it('opens its first Home reservation and accepts its promoted identity', async () => {
    const reservation = await store.reserveNew({ userId: 100, chatId: 200, token: VALID_TOKEN, view: HOME, now: NOW, expiresAt: later() });
    expect(reservation).toEqual({ kind: 'new', userId: 100, chatId: 200, messageId: null, token: VALID_TOKEN, revision: 1, view: HOME, expiresAt: later() });
    await expect(store.promoteNew(reservation, 300, NOW)).resolves.toEqual({ kind: 'promoted', active: identity(), previous: null });
    await expect(store.validate({ ...identity(), now: NOW })).resolves.toEqual({ kind: 'accepted', active: identity(), view: HOME });
  });

  it('promotes a reservation when SQLite timestamp storage truncates expiry milliseconds', async () => {
    const now = new Date('2030-01-01T00:00:00.789Z');
    const expiresAt = new Date(now.getTime() + 60_000);
    const reservation = await store.reserveNew({
      userId: 100,
      chatId: 200,
      token: VALID_TOKEN,
      view: HOME,
      now,
      expiresAt,
    });

    expect(sqlite.prepare('SELECT pending_expires_at AS expiresAt FROM home_sessions').get())
      .toEqual({ expiresAt: Math.floor(expiresAt.getTime() / 1_000) });
    await expect(store.promoteNew(reservation, 300, now)).resolves.toEqual({
      kind: 'promoted',
      active: identity(),
      previous: null,
    });
  });

  it('uses immediate transactions for every read-decide-write session transition', async () => {
    const transaction = vi.spyOn(db, 'transaction');
    const reservation = await store.reserveNew({ userId: 100, chatId: 200, token: VALID_TOKEN, view: HOME, now: NOW, expiresAt: later() });
    const promoted = await store.promoteNew(reservation, 300, NOW);
    if (promoted.kind !== 'promoted') throw new Error('expected active Home');
    const edit = await store.reserveEdit({ active: promoted.active, view: SENSORS, now: NOW, expiresAt: later() });
    if (edit.kind !== 'reserved') throw new Error('expected edit reservation');
    await store.validate({ ...promoted.active, now: NOW });
    await store.abandon(edit.reservation);
    await store.close({ ...promoted.active, now: NOW });

    expect(transaction.mock.calls).not.toHaveLength(0);
    for (const [, options] of transaction.mock.calls) {
      expect(options).toEqual({ behavior: 'immediate' });
    }
  });

  it('retains active authority through replacement and abandoned new-message reservations', async () => {
    const active = await openActive(store);
    const replacement = await store.reserveNew({ userId: active.userId, chatId: active.chatId, token: SECOND_TOKEN, view: SENSORS, now: NOW, expiresAt: later() });
    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({ kind: 'accepted', active });
    await store.abandon(replacement);
    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({ kind: 'accepted', active });
    await expect(store.promoteNew(replacement, 301, NOW)).resolves.toEqual({ kind: 'lost' });
  });

  it('retains the active Home until a replacement new-message reservation is promoted', async () => {
    const active = await openActive(store);
    const replacement = await store.reserveNew({ userId: active.userId, chatId: active.chatId, token: SECOND_TOKEN, view: SENSORS, now: NOW, expiresAt: later() });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'accepted', active, view: HOME });
    await expect(store.promoteNew(replacement, 301, NOW)).resolves.toEqual({
      kind: 'promoted',
      active: identity({ messageId: 301, token: SECOND_TOKEN }),
      previous: active,
    });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'stale' });
  });

  it('only promotes the newest concurrent new-message reservation', async () => {
    const first = await store.reserveNew({ userId: 100, chatId: 200, token: VALID_TOKEN, view: HOME, now: NOW, expiresAt: later() });
    const second = await store.reserveNew({ userId: 100, chatId: 200, token: SECOND_TOKEN, view: SENSORS, now: NOW, expiresAt: later() });
    await expect(store.promoteNew(first, 300, NOW)).resolves.toEqual({ kind: 'lost' });
    await expect(store.promoteNew(second, 301, NOW)).resolves.toMatchObject({ kind: 'promoted', active: identity({ messageId: 301, token: SECOND_TOKEN }) });
  });

  it('requires the full pending reservation identity for promotion and abandonment', async () => {
    const reservation = await store.reserveNew({ userId: 100, chatId: 200, token: VALID_TOKEN, view: HOME, now: NOW, expiresAt: later() });
    const altered: HomeReservation = { ...reservation, view: SENSORS, expiresAt: later(120_000) };
    await store.abandon(altered);
    await expect(store.promoteNew(altered, 300, NOW)).resolves.toEqual({ kind: 'lost' });
    await expect(store.promoteNew(reservation, 300, NOW)).resolves.toEqual({ kind: 'promoted', active: identity(), previous: null });
  });

  it('reserves and promotes exact edits with monotonic revisions', async () => {
    const active = await openActive(store);
    const first = await store.reserveEdit({ active, view: HOME, now: NOW, expiresAt: later() });
    const second = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (first.kind !== 'reserved' || second.kind !== 'reserved') throw new Error('expected reservations');
    expect(first.reservation.revision).toBe(2);
    expect(second.reservation.revision).toBe(3);
    await expect(store.promoteEdit(first.reservation, NOW)).resolves.toEqual({ kind: 'lost' });
    await expect(store.promoteEdit(second.reservation, NOW)).resolves.toEqual({ kind: 'promoted', active: identity({ revision: 3 }), previous: active });
  });

  it('rejects stale edit reservations and retains active authority after abandon', async () => {
    const active = await openActive(store);
    await expect(store.reserveEdit({ active: identity({ token: 'zyxwvutsrqponmlk' }), view: SENSORS, now: NOW, expiresAt: later() })).resolves.toEqual({ kind: 'stale' });
    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');
    await store.abandon(reserved.reservation);
    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({ kind: 'accepted', active });
  });

  it('promotes an exact unexpired pending edit during validation', async () => {
    const active = await openActive(store);
    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');
    const pendingIdentity = identity({ revision: reserved.reservation.revision });
    await expect(store.validate({ ...pendingIdentity, now: NOW })).resolves.toEqual({ kind: 'accepted', active: pendingIdentity, view: SENSORS });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'stale' });
  });

  it('expires pending edits at the exact boundary and reports updating only while pending', async () => {
    const active = await openActive(store);
    const expiresAt = later();
    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'updating' });
    await expect(store.validate({ ...identity({ revision: reserved.reservation.revision }), now: expiresAt })).resolves.toEqual({ kind: 'stale' });
    await expect(store.validate({ ...active, now: expiresAt })).resolves.toMatchObject({ kind: 'accepted', active });
  });

  it('deletes an expired pending-new row with no active Home authority', async () => {
    const reservation = await store.reserveNew({
      userId: 100,
      chatId: 200,
      token: VALID_TOKEN,
      view: HOME,
      now: NOW,
      expiresAt: NOW,
    });

    await expect(store.validate({ ...identity({ token: reservation.token }), now: NOW })).resolves.toEqual({ kind: 'closed' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM home_sessions').get()).toEqual({ count: 0 });
  });

  it('rejects malformed callback identities without changing authority and closes exact identities atomically', async () => {
    const active = await openActive(store);
    for (const candidate of [{ ...active, messageId: 301 }, { ...active, token: 'zyxwvutsrqponmlk' }, { ...active, revision: 2 }]) {
      await expect(store.validate({ ...candidate, now: NOW })).resolves.toEqual({ kind: 'stale' });
    }
    await expect(store.validate({ ...active, userId: 101, now: NOW })).resolves.toEqual({ kind: 'closed' });
    await expect(store.validate({ ...active, chatId: 201, now: NOW })).resolves.toEqual({ kind: 'closed' });
    await expect(store.close({ ...active, now: NOW })).resolves.toBe('closed');
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'closed' });
    await expect(store.close({ ...active, now: NOW })).resolves.toBe('stale');
  });

  it('recovers session authority when a fresh adapter opens the same database', async () => {
    const active = await openActive(store);
    const restartedSqlite = new Database(databasePath);
    restartedSqlite.pragma('foreign_keys = ON');
    try {
      const restarted = new DrizzleHomeSessionStore(drizzle(restartedSqlite, { schema }));
      await expect(restarted.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'accepted', active, view: HOME });
    } finally {
      restartedSqlite.close();
    }
  });

  it('rolls back a failed promotion transaction without partially changing authority', async () => {
    const active = await openActive(store);
    const reservation = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (reservation.kind !== 'reserved') throw new Error('expected reservation');
    sqlite.exec(`CREATE TRIGGER fail_home_promotion BEFORE UPDATE OF active_revision ON home_sessions WHEN NEW.active_revision = ${reservation.reservation.revision} BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
    await expect(store.promoteEdit(reservation.reservation, NOW)).rejects.toThrow('forced');
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'updating' });
  });

  it('returns lost when a guarded promotion write changes no row', async () => {
    const active = await openActive(store);
    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (reserved.kind !== 'reserved') throw new Error('expected reservation');
    sqlite.exec(`CREATE TRIGGER remove_home_before_promotion
      BEFORE UPDATE OF active_revision ON home_sessions
      BEGIN DELETE FROM home_sessions WHERE user_id = OLD.user_id AND chat_id = OLD.chat_id; END;`);

    await expect(store.promoteEdit(reserved.reservation, NOW)).resolves.toEqual({ kind: 'lost' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM home_sessions').get()).toEqual({ count: 0 });
  });

  it('waits through deterministic two-connection immediate-lock contention without SQLITE_BUSY', async () => {
    const secondSqlite = new Database(databasePath);
    configureContentionConnection(secondSqlite);
    try {
      const second = new DrizzleHomeSessionStore(drizzle(secondSqlite, { schema }));
      const lockHolder = await holdImmediateLock(databasePath);
      try {
        await expect(second.reserveNew({ userId: 100, chatId: 200, token: SECOND_TOKEN, view: SENSORS, now: NOW, expiresAt: later() })).resolves.toMatchObject({ kind: 'new', token: SECOND_TOKEN });
      } finally {
        await lockHolder.terminate();
      }
    } finally {
      secondSqlite.close();
    }
  });
});
