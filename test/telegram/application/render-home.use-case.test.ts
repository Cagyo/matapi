import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';
import type { HomeScreen } from '../../../src/telegram/application/home-screen';
import { OpenHomeUseCase } from '../../../src/telegram/application/open-home.use-case';
import { RenderHomeUseCase } from '../../../src/telegram/application/render-home.use-case';
import type { HomeIdentity, HomeReservation } from '../../../src/telegram/domain/home-session';
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
const screen: HomeScreen = {
  kind: 'home',
  summary: {
    verdict: 'normal', sensors: [], attention: [], attentionTotal: 0,
    knownCount: 0, unknownCount: 0, health: null, healthFresh: false,
    notificationState: { kind: 'normal' },
  },
  checking: false,
};

class RecordingSessionStore extends InMemoryHomeSessionStore {
  readonly calls: string[] = [];

  override async reserveEdit(input: Parameters<InMemoryHomeSessionStore['reserveEdit']>[0]) {
    this.calls.push('reserve');
    return super.reserveEdit(input);
  }

  override async promoteEdit(reservation: HomeReservation, now: Date) {
    this.calls.push('promote');
    return super.promoteEdit(reservation, now);
  }

  override async abandon(reservation: HomeReservation): Promise<void> {
    this.calls.push('abandon');
    return super.abandon(reservation);
  }
}

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

function setup(tokens = ['qrstuvwxyzabcdef']) {
  const sessions = new RecordingSessionStore();
  const delivery = new InMemoryHomeMessageDeliveryAdapter();
  const getScreen = { execute: async () => screen };
  const clock: ClockPort = { now: () => NOW };
  const generator = { generate: () => tokens.shift() ?? 'ponmlkjihgfedcba' };
  const open = new OpenHomeUseCase(sessions, generator, getScreen, delivery, clock);
  return {
    sessions,
    delivery,
    getScreen,
    useCase: new RenderHomeUseCase(sessions, getScreen, delivery, open, clock),
  };
}

const input = {
  active: ACTIVE,
  locale: 'en' as const,
  role: 'user' as const,
  view: { kind: 'home' as const, checking: false },
};

describe('RenderHomeUseCase', () => {
  it('reserves, edits with the pending revision, then promotes the exact active identity', async () => {
    const { sessions, delivery, useCase } = setup();
    await seed(sessions);
    sessions.calls.length = 0;

    await expect(useCase.execute(input)).resolves.toEqual({
      kind: 'rendered',
      active: { ...ACTIVE, revision: 2 },
    });
    expect(sessions.calls).toEqual(['reserve', 'promote']);
    expect(delivery.calls).toEqual([expect.objectContaining({
      kind: 'edit',
      input: expect.objectContaining({ identity: { ...ACTIVE, revision: 2 } }),
    })]);
  });

  it('abandons the exact edit then successfully reopens after an edit delivery failure', async () => {
    const { sessions, delivery, useCase } = setup(['qrstuvwxyzabcdef']);
    await seed(sessions);
    sessions.calls.length = 0;
    delivery.editError = new Error('edit failed');

    await expect(useCase.execute(input)).resolves.toMatchObject({
      kind: 'reopened',
      active: { messageId: 1, token: 'qrstuvwxyzabcdef', revision: 1 },
    });
    expect(sessions.calls).toEqual(['reserve', 'abandon']);
    expect(delivery.calls.map(({ kind }) => kind)).toEqual(['edit', 'send', 'stripKeyboard']);
  });

  it('returns delivery_failed and retains the old authority when edit and reopen delivery both fail', async () => {
    const { sessions, delivery, useCase } = setup();
    await seed(sessions);
    delivery.editError = new Error('edit failed');
    delivery.sendError = new Error('send failed');

    await expect(useCase.execute(input)).resolves.toEqual({ kind: 'delivery_failed' });
    await expect(sessions.validate({ ...ACTIVE, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', active: ACTIVE,
    });
  });

  it('returns superseded without stripping the shared message when edit promotion loses CAS', async () => {
    const { sessions, delivery, useCase } = setup();
    await seed(sessions);
    delivery.onEdit = async () => {
      await sessions.reserveNew({
        userId: ACTIVE.userId,
        chatId: ACTIVE.chatId,
        token: 'qrstuvwxyzabcdef',
        view: { kind: 'home', checking: false },
        now: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
    };
    sessions.calls.length = 0;
    delivery.calls.length = 0;

    await expect(useCase.execute(input)).resolves.toEqual({ kind: 'superseded' });
    expect(delivery.calls.map(({ kind }) => kind)).toEqual(['edit']);
    await expect(sessions.validate({ ...ACTIVE, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', active: ACTIVE,
    });
  });

  it('returns stale without contacting delivery when the identity is no longer active', async () => {
    const { delivery, useCase } = setup();

    await expect(useCase.execute(input)).resolves.toEqual({ kind: 'stale' });
    expect(delivery.calls).toEqual([]);
  });

  it('abandons the exact pending edit when screen construction fails', async () => {
    const { sessions, delivery, getScreen, useCase } = setup();
    await seed(sessions);
    sessions.calls.length = 0;
    getScreen.execute = async () => { throw new Error('summary unavailable'); };

    await expect(useCase.execute(input)).rejects.toThrow('summary unavailable');
    expect(sessions.calls).toEqual(['reserve', 'abandon']);
    expect(delivery.calls).toEqual([]);
    await expect(sessions.validate({ ...ACTIVE, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', active: ACTIVE,
    });
  });
});
