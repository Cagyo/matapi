import { describe, expect, it } from 'vitest';
import { CloseHomeUseCase } from '../../../src/telegram/application/close-home.use-case';
import type { HomeIdentity } from '../../../src/telegram/domain/home-session';
import { InMemoryHomeMessageDeliveryAdapter } from '../../../src/telegram/infrastructure/in-memory-home-message-delivery.adapter';
import { InMemoryHomeSessionStore } from '../../../src/telegram/infrastructure/in-memory-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ACTIVE: HomeIdentity = {
  userId: 7,
  chatId: 70,
  messageId: 10,
  token: 'abcdefghijklmnop',
  revision: 1,
};

async function seed(store: InMemoryHomeSessionStore): Promise<HomeIdentity> {
  const reservation = await store.reserveNew({
    userId: ACTIVE.userId,
    chatId: ACTIVE.chatId,
    token: ACTIVE.token,
    view: { kind: 'home', checking: false },
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const result = await store.promoteNew(reservation, ACTIVE.messageId, NOW);
  if (result.kind !== 'promoted') throw new Error('expected active Home');
  return result.active;
}

describe('CloseHomeUseCase', () => {
  it('clears exact authority before asking delivery to render the best-effort closed state', async () => {
    const sessions = new InMemoryHomeSessionStore();
    const delivery = new InMemoryHomeMessageDeliveryAdapter();
    await seed(sessions);
    let stateDuringDelivery: string | null = null;
    delivery.onCloseMessage = async () => {
      stateDuringDelivery = (await sessions.validate({ ...ACTIVE, now: NOW })).kind;
    };
    const useCase = new CloseHomeUseCase(sessions, delivery, { now: () => NOW });

    await expect(useCase.execute({ identity: ACTIVE, locale: 'en' })).resolves.toEqual('closed');
    expect(stateDuringDelivery).toBe('closed');
    expect(delivery.calls).toEqual([{
      kind: 'closeMessage', chatId: 70, messageId: 10, locale: 'en',
    }]);
  });

  it('returns stale without touching Telegram when the identity no longer matches', async () => {
    const sessions = new InMemoryHomeSessionStore();
    const delivery = new InMemoryHomeMessageDeliveryAdapter();
    const useCase = new CloseHomeUseCase(sessions, delivery, { now: () => NOW });

    await expect(useCase.execute({ identity: ACTIVE, locale: 'en' })).resolves.toEqual('stale');
    expect(delivery.calls).toEqual([]);
  });

  it('keeps the state closed when best-effort Telegram cleanup fails', async () => {
    const sessions = new InMemoryHomeSessionStore();
    const delivery = new InMemoryHomeMessageDeliveryAdapter();
    await seed(sessions);
    delivery.closeMessageError = new Error('close delivery failed');
    const useCase = new CloseHomeUseCase(sessions, delivery, { now: () => NOW });

    await expect(useCase.execute({ identity: ACTIVE, locale: 'en' })).resolves.toEqual('closed');
    await expect(sessions.validate({ ...ACTIVE, now: NOW })).resolves.toEqual({ kind: 'closed' });
  });
});
