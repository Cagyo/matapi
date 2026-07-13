import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../../src/database/database.tokens';
import * as schema from '../../../src/database/schema';
import type { HomeIdentity, HomeReservation, HomeView } from '../../../src/telegram/domain/home-session';
import { DrizzleHomeSessionStore } from '../../../src/telegram/infrastructure/drizzle-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const HOME: HomeView = { kind: 'home', checking: false };
const SENSORS: HomeView = { kind: 'sensors', page: 2, checking: true };

function later(milliseconds = 60_000): Date {
  return new Date(NOW.getTime() + milliseconds);
}

function identity(overrides: Partial<HomeIdentity> = {}): HomeIdentity {
  return { userId: 100, chatId: 200, messageId: 300, token: 'token-a', revision: 1, ...overrides };
}

async function openActive(store: DrizzleHomeSessionStore, overrides: Partial<Pick<HomeIdentity, 'userId' | 'chatId' | 'messageId' | 'token'>> = {}): Promise<HomeIdentity> {
  const reservation = await store.reserveNew({
    userId: overrides.userId ?? 100,
    chatId: overrides.chatId ?? 200,
    token: overrides.token ?? 'token-a',
    view: HOME,
    now: NOW,
    expiresAt: later(),
  });
  const result = await store.promoteNew(reservation, overrides.messageId ?? 300, NOW);
  if (result.kind !== 'promoted') throw new Error('expected active Home');
  return result.active;
}

describe('DrizzleHomeSessionStore', () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let store: DrizzleHomeSessionStore;
  let databaseDirectory: string;
  let databasePath: string;

  beforeEach(() => {
    databaseDirectory = mkdtempSync(join(tmpdir(), 'home-session-store-'));
    databasePath = join(databaseDirectory, 'home.db');
    sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema }) as AppDatabase;
    migrate(db, { migrationsFolder: './migrations' });
    sqlite.prepare(`INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)`).run(100, 'User', 'user', 'en');
    store = new DrizzleHomeSessionStore(db);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(databaseDirectory, { recursive: true, force: true });
  });

  it('opens its first Home reservation and accepts its promoted identity', async () => {
    const reservation = await store.reserveNew({ userId: 100, chatId: 200, token: 'token-a', view: HOME, now: NOW, expiresAt: later() });
    expect(reservation).toEqual({ kind: 'new', userId: 100, chatId: 200, messageId: null, token: 'token-a', revision: 1, view: HOME, expiresAt: later() });
    await expect(store.promoteNew(reservation, 300, NOW)).resolves.toEqual({ kind: 'promoted', active: identity(), previous: null });
    await expect(store.validate({ ...identity(), now: NOW })).resolves.toEqual({ kind: 'accepted', active: identity(), view: HOME });
  });

  it('retains active authority through replacement and abandoned new-message reservations', async () => {
    const active = await openActive(store);
    const replacement = await store.reserveNew({ userId: active.userId, chatId: active.chatId, token: 'token-b', view: SENSORS, now: NOW, expiresAt: later() });
    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({ kind: 'accepted', active });
    await store.abandon(replacement);
    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({ kind: 'accepted', active });
    await expect(store.promoteNew(replacement, 301, NOW)).resolves.toEqual({ kind: 'lost' });
  });

  it('retains the active Home until a replacement new-message reservation is promoted', async () => {
    const active = await openActive(store);
    const replacement = await store.reserveNew({ userId: active.userId, chatId: active.chatId, token: 'token-b', view: SENSORS, now: NOW, expiresAt: later() });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'accepted', active, view: HOME });
    await expect(store.promoteNew(replacement, 301, NOW)).resolves.toEqual({
      kind: 'promoted',
      active: identity({ messageId: 301, token: 'token-b' }),
      previous: active,
    });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'stale' });
  });

  it('only promotes the newest concurrent new-message reservation', async () => {
    const first = await store.reserveNew({ userId: 100, chatId: 200, token: 'token-a', view: HOME, now: NOW, expiresAt: later() });
    const second = await store.reserveNew({ userId: 100, chatId: 200, token: 'token-b', view: SENSORS, now: NOW, expiresAt: later() });
    await expect(store.promoteNew(first, 300, NOW)).resolves.toEqual({ kind: 'lost' });
    await expect(store.promoteNew(second, 301, NOW)).resolves.toMatchObject({ kind: 'promoted', active: identity({ messageId: 301, token: 'token-b' }) });
  });

  it('requires the full pending reservation identity for promotion and abandonment', async () => {
    const reservation = await store.reserveNew({ userId: 100, chatId: 200, token: 'token-a', view: HOME, now: NOW, expiresAt: later() });
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
    await expect(store.reserveEdit({ active: identity({ token: 'wrong-token' }), view: SENSORS, now: NOW, expiresAt: later() })).resolves.toEqual({ kind: 'stale' });
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

  it('rejects malformed callback identities without changing authority and closes exact identities atomically', async () => {
    const active = await openActive(store);
    for (const candidate of [{ ...active, messageId: 301 }, { ...active, token: 'wrong-token' }, { ...active, revision: 2 }]) {
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
      const restarted = new DrizzleHomeSessionStore(drizzle(restartedSqlite, { schema }) as AppDatabase);
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

  it('allows only one repository instance to win race-like reservation and promotion CAS operations', async () => {
    const secondSqlite = new Database(databasePath);
    secondSqlite.pragma('foreign_keys = ON');
    try {
      const second = new DrizzleHomeSessionStore(drizzle(secondSqlite, { schema }) as AppDatabase);
      const [firstReservation, secondReservation] = await Promise.all([
        store.reserveNew({ userId: 100, chatId: 200, token: 'token-a', view: HOME, now: NOW, expiresAt: later() }),
        second.reserveNew({ userId: 100, chatId: 200, token: 'token-b', view: SENSORS, now: NOW, expiresAt: later() }),
      ]);
      const results = await Promise.all([
        store.promoteNew(firstReservation, 300, NOW),
        second.promoteNew(secondReservation, 301, NOW),
      ]);
      expect(results.filter((result) => result.kind === 'promoted')).toHaveLength(1);
      const promoted = results.find((result): result is Extract<typeof result, { kind: 'promoted' }> => result.kind === 'promoted');
      if (!promoted) throw new Error('expected a winner');
      await expect(store.validate({ ...promoted.active, now: NOW })).resolves.toMatchObject({ kind: 'accepted', active: promoted.active });
    } finally {
      secondSqlite.close();
    }
  });
});
