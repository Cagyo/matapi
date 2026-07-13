import { describe, expect, it } from 'vitest';
import { PauseNonCriticalNotificationsUseCase } from '../../../src/telegram/application/pause-non-critical-notifications.use-case';
import { ResumeNonCriticalNotificationsUseCase } from '../../../src/telegram/application/resume-non-critical-notifications.use-case';
import { UndoNonCriticalPauseUseCase } from '../../../src/telegram/application/undo-non-critical-pause.use-case';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { User } from '../../../src/telegram/domain/user.entity';

const NOW = new Date('2030-01-01T00:00:00.000Z');

function seedUser(telegramId: number): User {
  return {
    telegramId,
    name: 'Ada',
    role: 'user',
    locale: 'en',
    muted: false,
    nonCriticalPausedUntil: null,
    notificationPauseRevision: 0,
    quietStart: null,
    quietEnd: null,
    createdAt: null,
  };
}

function setup() {
  const clockState = { now: NOW };
  const clock: ClockPort = { now: () => clockState.now };
  const repo = new InMemoryUserRepository([seedUser(1), seedUser(2)]);
  const pause = new PauseNonCriticalNotificationsUseCase(repo, clock);
  const resume = new ResumeNonCriticalNotificationsUseCase(repo, clock);
  const undo = new UndoNonCriticalPauseUseCase(repo, clock);
  return { repo, pause, resume, undo, setNow: (d: Date) => (clockState.now = d) };
}

describe('UndoNonCriticalPauseUseCase', () => {
  it('restores the prior active deadline and increments the revision', async () => {
    const { pause, undo } = setup();
    await pause.execute(1, 1); // deadline NOW+1h, revision 1
    const second = await pause.execute(1, 4); // deadline NOW+4h, revision 2, prev = NOW+1h

    const result = await undo.execute(1, second.receiptId);

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.state.nonCriticalPausedUntil).toEqual(
        new Date('2030-01-01T01:00:00.000Z'),
      );
      expect(result.state.revision).toBe(3);
    }
  });

  it('restores null when there was no prior pause', async () => {
    const { pause, undo } = setup();
    const first = await pause.execute(1, 1); // prev = null

    const result = await undo.execute(1, first.receiptId);

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.state.nonCriticalPausedUntil).toBeNull();
      expect(result.state.revision).toBe(2);
    }
  });

  it('restores null when the prior deadline had already expired at mutation time', async () => {
    const { pause, undo, setNow } = setup();
    await pause.execute(1, 1); // deadline NOW+1h
    setNow(new Date('2030-01-01T02:00:00.000Z')); // past that deadline
    const second = await pause.execute(1, 1); // prev normalized to null

    const result = await undo.execute(1, second.receiptId);

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.state.nonCriticalPausedUntil).toBeNull();
    }
  });

  it('returns consumed when reusing an already-consumed receipt', async () => {
    const { pause, undo } = setup();
    const first = await pause.execute(1, 1);
    await undo.execute(1, first.receiptId);

    expect((await undo.execute(1, first.receiptId)).kind).toBe('consumed');
  });

  it('returns not_found for a receipt owned by another user', async () => {
    const { pause, undo } = setup();
    const first = await pause.execute(1, 1);

    expect((await undo.execute(2, first.receiptId)).kind).toBe('not_found');
  });

  it('returns expired at the exact expiry instant (now === expiresAt)', async () => {
    const { pause, undo, setNow } = setup();
    const first = await pause.execute(1, 1); // expiresAt = NOW+1h
    setNow(new Date('2030-01-01T01:00:00.000Z'));

    expect((await undo.execute(1, first.receiptId)).kind).toBe('expired');
  });

  it('supersedes the first receipt after a second pause', async () => {
    const { pause, undo } = setup();
    const first = await pause.execute(1, 1);
    await pause.execute(1, 4);

    expect((await undo.execute(1, first.receiptId)).kind).toBe('superseded');
  });

  it('supersedes the latest receipt after a resume changes the revision', async () => {
    const { pause, resume, undo } = setup();
    const first = await pause.execute(1, 1);
    await resume.execute(1);

    expect((await undo.execute(1, first.receiptId)).kind).toBe('superseded');
  });

  it('retains only the newest 32 receipts per user', async () => {
    const { pause, undo } = setup();
    const ids: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      ids.push((await pause.execute(1, 1)).receiptId);
    }

    // The latest receipt is still undoable.
    expect((await undo.execute(1, ids[ids.length - 1])).kind).toBe('applied');
    // The 8 oldest were evicted → not_found.
    for (let i = 0; i < 8; i += 1) {
      expect((await undo.execute(1, ids[i])).kind).toBe('not_found');
    }
    // A retained-but-not-latest receipt → superseded.
    expect((await undo.execute(1, ids[20])).kind).toBe('superseded');
  });
});
