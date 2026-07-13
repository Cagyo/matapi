import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleUserRepository } from '../../../src/telegram/infrastructure/drizzle-user.repository';
import { notificationPauseReceipts } from '../../../src/database/schema';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

// Second-aligned instants only: Drizzle timestamp mode persists whole seconds.
const NOW = new Date('2030-01-01T00:00:00.000Z');
const IN_1H = new Date('2030-01-01T01:00:00.000Z');
const IN_4H = new Date('2030-01-01T04:00:00.000Z');

describe('DrizzleUserRepository notification pause', () => {
  let context: TestDatabaseContext;
  let repo: DrizzleUserRepository;

  beforeEach(() => {
    context = createTestDatabase();
    repo = new DrizzleUserRepository(context.appDb);
  });

  afterEach(() => context.close());

  async function makeUser(telegramId: number): Promise<void> {
    await repo.createUser({
      telegramId,
      name: `U${telegramId}`,
      role: 'user',
      locale: 'en',
      createdAt: NOW,
    });
  }

  function receiptCount(userId: number): number {
    return context.db
      .select()
      .from(notificationPauseReceipts)
      .where(eq(notificationPauseReceipts.userId, userId))
      .all().length;
  }

  it('applies a timed pause, persists the deadline, and returns a receipt', async () => {
    await makeUser(1);

    const result = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.state.nonCriticalPausedUntil).toEqual(IN_1H);
      expect(result.state.revision).toBe(1);
      expect(typeof result.receiptId).toBe('number');
    }
    expect(await repo.getNotificationPauseState(1)).toEqual({
      userId: 1,
      legacyMuted: false,
      nonCriticalPausedUntil: IN_1H,
      revision: 1,
    });
  });

  it('rejects a timed pause for a legacy-muted user and inserts no receipt', async () => {
    await makeUser(1);
    await repo.setMuted(1, true);
    const state = await repo.getNotificationPauseState(1);

    const result = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: state!.revision,
      pausedUntil: IN_1H,
      now: NOW,
    });

    expect(result.kind).toBe('legacy_active');
    expect(receiptCount(1)).toBe(0);
  });

  it('rejects a stale expected revision with conflict and inserts no receipt', async () => {
    await makeUser(1);
    await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });

    const stale = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0, // already consumed by the first apply
      pausedUntil: IN_4H,
      now: NOW,
    });

    expect(stale.kind).toBe('conflict');
    expect(receiptCount(1)).toBe(1);
  });

  it('resume clears legacy mute and the timed pause together and increments once', async () => {
    await makeUser(1);
    await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    await repo.setMuted(1, true); // revision → 2, muted true, deadline still set
    const before = await repo.getNotificationPauseState(1);

    const result = await repo.resumeNotifications({
      userId: 1,
      expectedRevision: before!.revision,
      now: NOW,
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.changed).toBe(true);
      expect(result.state.legacyMuted).toBe(false);
      expect(result.state.nonCriticalPausedUntil).toBeNull();
      expect(result.state.revision).toBe(before!.revision + 1);
    }
  });

  it('resume reports changed:false without incrementing when nothing is set', async () => {
    await makeUser(1);

    const result = await repo.resumeNotifications({
      userId: 1,
      expectedRevision: 0,
      now: NOW,
    });

    expect(result).toEqual({
      kind: 'applied',
      changed: false,
      state: { userId: 1, legacyMuted: false, nonCriticalPausedUntil: null, revision: 0 },
    });
  });

  it('undo restores the prior active deadline, increments revision, and consumes the receipt', async () => {
    await makeUser(1);
    await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    const second = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 1,
      pausedUntil: IN_4H,
      now: NOW,
    });
    const receiptId = second.kind === 'applied' ? second.receiptId : -1;

    const result = await repo.undoNonCriticalPause(1, receiptId, NOW);

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.state.nonCriticalPausedUntil).toEqual(IN_1H);
      expect(result.state.revision).toBe(3);
    }
    // Consumed atomically: a second undo of the same receipt is rejected.
    expect((await repo.undoNonCriticalPause(1, receiptId, NOW)).kind).toBe('consumed');
  });

  it('undo returns expired at the exact expiry instant', async () => {
    await makeUser(1);
    const applied = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    const receiptId = applied.kind === 'applied' ? applied.receiptId : -1;

    expect((await repo.undoNonCriticalPause(1, receiptId, IN_1H)).kind).toBe('expired');
  });

  it('undo returns not_found for a receipt owned by another user', async () => {
    await makeUser(1);
    await makeUser(2);
    const applied = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    const receiptId = applied.kind === 'applied' ? applied.receiptId : -1;

    expect((await repo.undoNonCriticalPause(2, receiptId, NOW)).kind).toBe('not_found');
  });

  it('undo returns superseded after a second pause', async () => {
    await makeUser(1);
    const first = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 1,
      pausedUntil: IN_4H,
      now: NOW,
    });
    const receiptId = first.kind === 'applied' ? first.receiptId : -1;

    expect((await repo.undoNonCriticalPause(1, receiptId, NOW)).kind).toBe('superseded');
  });

  it('setMuted supersedes a pending undo by incrementing the revision', async () => {
    await makeUser(1);
    const applied = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    const receiptId = applied.kind === 'applied' ? applied.receiptId : -1;

    await repo.setMuted(1, true); // real toggle → revision bump

    expect((await repo.undoNonCriticalPause(1, receiptId, NOW)).kind).toBe('superseded');
  });

  it('persists state and receipts across a fresh repository instance', async () => {
    await makeUser(1);
    const applied = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    const receiptId = applied.kind === 'applied' ? applied.receiptId : -1;

    const fresh = new DrizzleUserRepository(context.appDb);
    expect(await fresh.getNotificationPauseState(1)).toEqual({
      userId: 1,
      legacyMuted: false,
      nonCriticalPausedUntil: IN_1H,
      revision: 1,
    });
    expect((await fresh.undoNonCriticalPause(1, receiptId, NOW)).kind).toBe('applied');
  });

  it('assigns strictly increasing receipt ids', async () => {
    await makeUser(1);
    const a = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });
    const b = await repo.applyNonCriticalPause({
      userId: 1,
      expectedRevision: 1,
      pausedUntil: IN_4H,
      now: NOW,
    });

    const idA = a.kind === 'applied' ? a.receiptId : -1;
    const idB = b.kind === 'applied' ? b.receiptId : -2;
    expect(idB).toBeGreaterThan(idA);
  });

  it('caps retained receipts at 32 per user without pruning another user', async () => {
    await makeUser(1);
    await makeUser(2);
    await repo.applyNonCriticalPause({
      userId: 2,
      expectedRevision: 0,
      pausedUntil: IN_1H,
      now: NOW,
    });

    let revision = 0;
    for (let i = 0; i < 40; i += 1) {
      const result = await repo.applyNonCriticalPause({
        userId: 1,
        expectedRevision: revision,
        pausedUntil: IN_1H,
        now: NOW,
      });
      revision = result.kind === 'applied' ? result.state.revision : revision;
    }

    expect(receiptCount(1)).toBe(32);
    expect(receiptCount(2)).toBe(1);
  });
});
