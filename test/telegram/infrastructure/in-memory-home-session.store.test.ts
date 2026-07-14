import { describe, expect, it } from 'vitest';
import type { HomeIdentity, HomeView } from '../../../src/telegram/domain/home-session';
import { InMemoryHomeSessionStore } from '../../../src/telegram/infrastructure/in-memory-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const HOME: HomeView = { kind: 'home', checking: false };
const SENSORS: HomeView = { kind: 'sensors', page: 2, checking: true };

function later(milliseconds = 60_000): Date {
  return new Date(NOW.getTime() + milliseconds);
}

function identity(overrides: Partial<HomeIdentity> = {}): HomeIdentity {
  return {
    userId: 100,
    chatId: 200,
    messageId: 300,
    token: 'token-a',
    revision: 1,
    ...overrides,
  };
}

async function openActive(
  store: InMemoryHomeSessionStore,
  overrides: Partial<Pick<HomeIdentity, 'userId' | 'chatId' | 'messageId' | 'token'>> = {},
): Promise<HomeIdentity> {
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

describe('InMemoryHomeSessionStore', () => {
  it('keeps caller-owned notification targets isolated across reservation and validation', async () => {
    const store = new InMemoryHomeSessionStore();
    const targets = [
      { kind: 'sensor' as const, id: 'a0a0a0a0-0000-4000-8000-000000000001' },
      { kind: 'camera' as const, id: 'a0a0a0a0-0000-4000-8000-000000000002' },
    ];
    const reservation = await store.reserveNew({
      userId: 100, chatId: 200, token: 'token-a',
      view: { kind: 'notification-targets', page: 1, targets }, now: NOW, expiresAt: later(),
    });
    targets[0].id = 'a0a0a0a0-0000-4000-8000-000000000003';
    targets.push({ kind: 'sensor', id: 'a0a0a0a0-0000-4000-8000-000000000004' });
    await store.promoteNew(reservation, 300, NOW);

    await expect(store.validate({ ...identity(), now: NOW })).resolves.toEqual({
      kind: 'accepted', active: identity(),
      view: {
        kind: 'notification-targets', page: 1,
        targets: [
          { kind: 'sensor', id: 'a0a0a0a0-0000-4000-8000-000000000001' },
          { kind: 'camera', id: 'a0a0a0a0-0000-4000-8000-000000000002' },
        ],
      },
    });
  });

  it('opens its first Home reservation and accepts its promoted identity', async () => {
    const store = new InMemoryHomeSessionStore();
    const reservation = await store.reserveNew({
      userId: 100,
      chatId: 200,
      token: 'token-a',
      view: HOME,
      now: NOW,
      expiresAt: later(),
    });

    expect(reservation).toEqual({
      kind: 'new',
      userId: 100,
      chatId: 200,
      messageId: null,
      token: 'token-a',
      revision: 1,
      view: HOME,
      expiresAt: later(),
    });

    await expect(store.promoteNew(reservation, 300, NOW)).resolves.toEqual({
      kind: 'promoted',
      active: identity(),
      previous: null,
    });
    await expect(store.validate({ ...identity(), now: NOW })).resolves.toEqual({
      kind: 'accepted',
      active: identity(),
      view: HOME,
    });
  });

  it('retains the active Home while a replacement new-message reservation is pending', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    const replacement = await store.reserveNew({
      userId: active.userId,
      chatId: active.chatId,
      token: 'token-b',
      view: SENSORS,
      now: NOW,
      expiresAt: later(),
    });

    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({
      kind: 'accepted',
      active,
    });
    await expect(store.promoteNew(replacement, 301, NOW)).resolves.toEqual({
      kind: 'promoted',
      active: identity({ messageId: 301, token: 'token-b' }),
      previous: active,
    });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'stale' });
  });

  it('abandons a failed new-message reservation without clearing active authority', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    const reservation = await store.reserveNew({
      userId: active.userId,
      chatId: active.chatId,
      token: 'token-b',
      view: SENSORS,
      now: NOW,
      expiresAt: later(),
    });

    await store.abandon(reservation);

    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({
      kind: 'accepted',
      active,
    });
    await expect(store.promoteNew(reservation, 301, NOW)).resolves.toEqual({ kind: 'lost' });
  });

  it('only promotes the newest concurrent new-message reservation', async () => {
    const store = new InMemoryHomeSessionStore();
    const first = await store.reserveNew({
      userId: 100,
      chatId: 200,
      token: 'token-a',
      view: HOME,
      now: NOW,
      expiresAt: later(),
    });
    const second = await store.reserveNew({
      userId: 100,
      chatId: 200,
      token: 'token-b',
      view: SENSORS,
      now: NOW,
      expiresAt: later(),
    });

    await expect(store.promoteNew(first, 300, NOW)).resolves.toEqual({ kind: 'lost' });
    await expect(store.promoteNew(second, 301, NOW)).resolves.toMatchObject({
      kind: 'promoted',
      active: identity({ messageId: 301, token: 'token-b' }),
    });
  });

  it('reserves and promotes an exact edit while retaining the same message identity', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    const reserved = await store.reserveEdit({
      active,
      view: SENSORS,
      now: NOW,
      expiresAt: later(),
    });

    expect(reserved).toEqual({
      kind: 'reserved',
      reservation: {
        kind: 'edit',
        userId: active.userId,
        chatId: active.chatId,
        messageId: active.messageId,
        token: active.token,
        revision: 2,
        view: SENSORS,
        expiresAt: later(),
      },
    });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');

    await expect(store.promoteEdit(reserved.reservation, NOW)).resolves.toEqual({
      kind: 'promoted',
      active: identity({ revision: 2 }),
      previous: active,
    });
  });

  it('rejects stale edit reservations and abandonment retains the active revision', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);

    await expect(
      store.reserveEdit({
        active: identity({ token: 'wrong-token' }),
        view: SENSORS,
        now: NOW,
        expiresAt: later(),
      }),
    ).resolves.toEqual({ kind: 'stale' });

    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');
    await store.abandon(reserved.reservation);

    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({
      kind: 'accepted',
      active,
    });
  });

  it('supersedes concurrent edits with monotonically increasing revisions', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    const first = await store.reserveEdit({ active, view: HOME, now: NOW, expiresAt: later() });
    const second = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (first.kind !== 'reserved' || second.kind !== 'reserved') throw new Error('expected reservations');

    expect(first.reservation.revision).toBe(2);
    expect(second.reservation.revision).toBe(3);
    expect(Number.isSafeInteger(second.reservation.revision)).toBe(true);
    await expect(store.promoteEdit(first.reservation, NOW)).resolves.toEqual({ kind: 'lost' });
    await expect(store.promoteEdit(second.reservation, NOW)).resolves.toMatchObject({
      kind: 'promoted',
      active: identity({ revision: 3 }),
    });
  });

  it('atomically promotes an exact unexpired pending edit callback', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');
    const pendingIdentity = identity({ revision: reserved.reservation.revision });

    await expect(store.validate({ ...pendingIdentity, now: NOW })).resolves.toEqual({
      kind: 'accepted',
      active: pendingIdentity,
      view: SENSORS,
    });
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'stale' });
  });

  it('rejects a pending edit at its exact expiry boundary and keeps the previous active Home', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    const expiresAt = later();
    const reserved = await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt });
    if (reserved.kind !== 'reserved') throw new Error('expected edit reservation');

    await expect(
      store.validate({ ...identity({ revision: reserved.reservation.revision }), now: expiresAt }),
    ).resolves.toEqual({ kind: 'stale' });
    await expect(store.validate({ ...active, now: expiresAt })).resolves.toMatchObject({
      kind: 'accepted',
      active,
    });
  });

  it('reports updating only for the active revision while an unexpired edit is pending', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });

    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'updating' });
  });

  it('rejects wrong callback identity fields without mutating active authority', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);

    for (const candidate of [
      { ...active, messageId: 301 },
      { ...active, token: 'wrong-token' },
      { ...active, revision: 2 },
    ]) {
      await expect(store.validate({ ...candidate, now: NOW })).resolves.toEqual({ kind: 'stale' });
    }
    await expect(
      store.validate({ ...active, userId: 101, now: NOW }),
    ).resolves.toEqual({ kind: 'closed' });
    await expect(
      store.validate({ ...active, chatId: 201, now: NOW }),
    ).resolves.toEqual({ kind: 'closed' });
    await expect(store.validate({ ...active, now: NOW })).resolves.toMatchObject({
      kind: 'accepted',
      active,
    });
  });

  it('closes exact authority atomically so later callbacks stay closed even when cleanup is external', async () => {
    const store = new InMemoryHomeSessionStore();
    const active = await openActive(store);
    await store.reserveEdit({ active, view: SENSORS, now: NOW, expiresAt: later() });

    await expect(store.close({ ...active, now: NOW })).resolves.toBe('closed');
    await expect(store.validate({ ...active, now: NOW })).resolves.toEqual({ kind: 'closed' });
    await expect(store.close({ ...active, now: NOW })).resolves.toBe('stale');
  });
});
