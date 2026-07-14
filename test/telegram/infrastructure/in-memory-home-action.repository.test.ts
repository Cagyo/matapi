import { describe, expect, it } from 'vitest';
import { isHomeActionReceipt, type HomeActionReceipt } from '../../../src/telegram/domain/home-action-receipt';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = new Date('2030-01-01T00:01:00.000Z');

function external(id = '1234567890abcdef'): HomeActionReceipt {
  return { id, userId: 100, chatId: 200, kind: 'cleanup-confirmation', sessionToken: 'token-a', status: 'pending', expiresAt: LATER, payload: {} };
}

describe('InMemoryHomeActionRepository', () => {
  it('rejects mismatched confirmation and undo receipt payloads at the boundary', () => {
    expect(isHomeActionReceipt({ ...external(), sessionToken: null })).toBe(false);
    expect(isHomeActionReceipt({ ...external(), payload: { hours: 4 } })).toBe(false);
    expect(isHomeActionReceipt({ id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'undo-non-critical-pause', sessionToken: null, status: 'pending', expiresAt: LATER, payload: { foundationReceiptId: 7 } })).toBe(false);
  });

  it('replaces only the same receipt kind and claims an exact pending external action once', async () => {
    const repository = new InMemoryHomeActionRepository();
    await repository.create(external());
    await repository.create({ ...external('abcdef1234567890'), kind: 'restart-confirmation' });
    await repository.create(external('0011223344556677'));

    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'superseded' });
    const claimed = await repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '0011223344556677', now: NOW });
    expect(claimed).toEqual({ kind: 'claimed', action: { id: '0011223344556677', userId: 100, chatId: 200, kind: 'cleanup-confirmation' } });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '0011223344556677', now: NOW })).resolves.toEqual({ kind: 'executing' });
  });

  it('rejects invalid claims, honours the expiry boundary, and records terminal completion', async () => {
    const repository = new InMemoryHomeActionRepository();
    await repository.create(external());
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'wrong', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'superseded' });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: 'wrong', now: NOW })).resolves.toEqual({ kind: 'superseded' });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: LATER })).resolves.toEqual({ kind: 'expired' });

    await repository.create(external());
    const result = await repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW });
    if (result.kind !== 'claimed') throw new Error('expected claimed action');
    await repository.finishExternal({ action: result.action, outcome: 'completed', now: NOW });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'terminal' });
  });

  it('finds only an unexpired pending current undo receipt', async () => {
    const repository = new InMemoryHomeActionRepository();
    const undo: HomeActionReceipt = { id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'undo-non-critical-pause', sessionToken: null, status: 'pending', expiresAt: LATER, payload: { foundationReceiptId: 7, expectedRevision: 3 } };
    await repository.create(undo);
    await expect(repository.findCurrentUndo({ userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: NOW })).resolves.toEqual(undo);
    await expect(repository.findCurrentUndo({ userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: LATER })).resolves.toBeNull();
  });

  it('commits a confirmed pause, its foundation receipt, and its Home undo together', async () => {
    const users = new InMemoryUserRepository([{
      telegramId: 100, name: 'Ada', role: 'user', locale: 'en', muted: false,
      nonCriticalPausedUntil: null, notificationPauseRevision: 0,
      quietStart: null, quietEnd: null, createdAt: null,
    }]);
    const repository = new InMemoryHomeActionRepository(users);
    await repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', expiresAt: new Date(NOW.getTime() + 120_000),
      payload: { hours: 4 },
    });

    await expect(repository.confirmPause({
      userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours: 4, now: NOW,
    })).resolves.toMatchObject({ kind: 'applied', expectedRevision: 1 });
    expect(await users.getNotificationPauseState(100)).toMatchObject({ revision: 1 });
    await expect(repository.findCurrentUndo({
      userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: NOW,
    })).resolves.toMatchObject({ kind: 'undo-non-critical-pause', payload: { expectedRevision: 1 } });
  });
});
