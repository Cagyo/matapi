import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';
import type { HomeScreen } from '../../../src/telegram/application/home-screen';
import { OpenHomeUseCase } from '../../../src/telegram/application/open-home.use-case';
import type {
  HomeIdentity,
  HomeReservation,
} from '../../../src/telegram/domain/home-session';
import { InMemoryHomeMessageDeliveryAdapter } from '../../../src/telegram/infrastructure/in-memory-home-message-delivery.adapter';
import { InMemoryHomeSessionStore } from '../../../src/telegram/infrastructure/in-memory-home-session.store';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const OLD: HomeIdentity = {
  userId: 7,
  chatId: 70,
  messageId: 10,
  token: 'oldtoken00000000',
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

const clampedSensorsScreen: HomeScreen = {
  kind: 'sensors',
  summary: screen.summary,
  page: {
    sensors: [], requestedPage: 12, page: 2, pageCount: 3, total: 17, clamped: true,
  },
  checking: false,
  isAdmin: false,
};

type ProtocolEvent = 'reserve' | 'send' | 'promote' | 'stripKeyboard' | 'abandon';

class RecordingSessionStore extends InMemoryHomeSessionStore {
  readonly calls: string[] = [];
  reservation: HomeReservation | null = null;

  constructor(private readonly protocolEvents: ProtocolEvent[]) {
    super();
  }

  override async reserveNew(input: Parameters<InMemoryHomeSessionStore['reserveNew']>[0]) {
    this.calls.push('reserve');
    this.protocolEvents.push('reserve');
    const reservation = await super.reserveNew(input);
    this.reservation = reservation;
    return reservation;
  }

  override async promoteNew(
    reservation: HomeReservation,
    messageId: number,
    now: Date,
  ) {
    this.calls.push('promote');
    this.protocolEvents.push('promote');
    return super.promoteNew(reservation, messageId, now);
  }

  override async abandon(reservation: HomeReservation): Promise<void> {
    this.calls.push('abandon');
    this.protocolEvents.push('abandon');
    return super.abandon(reservation);
  }
}

class RecordingDelivery extends InMemoryHomeMessageDeliveryAdapter {
  constructor(private readonly protocolEvents: ProtocolEvent[]) {
    super();
  }

  override async send(input: Parameters<InMemoryHomeMessageDeliveryAdapter['send']>[0]) {
    this.protocolEvents.push('send');
    return super.send(input);
  }

  override async stripKeyboard(chatId: number, messageId: number): Promise<void> {
    this.protocolEvents.push('stripKeyboard');
    return super.stripKeyboard(chatId, messageId);
  }
}

function setup(tokens = ['abcdefghijklmnop']) {
  const protocolEvents: ProtocolEvent[] = [];
  const sessions = new RecordingSessionStore(protocolEvents);
  const delivery = new RecordingDelivery(protocolEvents);
  const getScreen = { execute: async () => screen };
  const generator = { generate: () => tokens.shift() ?? 'qrstuvwxyzabcdef' };
  const clock: ClockPort = { now: () => NOW };
  return {
    sessions,
    delivery,
    protocolEvents,
    getScreen,
    useCase: new OpenHomeUseCase(sessions, generator, getScreen, delivery, clock),
  };
}

async function active(store: InMemoryHomeSessionStore): Promise<HomeIdentity> {
  const reservation = await store.reserveNew({
    userId: OLD.userId,
    chatId: OLD.chatId,
    token: OLD.token,
    view: { kind: 'home', checking: false },
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const result = await store.promoteNew(reservation, OLD.messageId, NOW);
  if (result.kind !== 'promoted') throw new Error('expected active session');
  return result.active;
}

describe('OpenHomeUseCase', () => {
  it('reserves, sends, then promotes a new Home with a 60-second pending expiry', async () => {
    const { sessions, delivery, protocolEvents, useCase } = setup();

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'home', checking: false },
    })).resolves.toMatchObject({
      kind: 'opened',
      active: { userId: 7, chatId: 70, messageId: 1, token: 'abcdefghijklmnop', revision: 1 },
    });
    expect(protocolEvents).toEqual(['reserve', 'send', 'promote']);
    expect(sessions.reservation?.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(delivery.calls[0]).toMatchObject({
      kind: 'send',
      input: { identity: { userId: 7, chatId: 70, token: 'abcdefghijklmnop', revision: 1 } },
    });
  });

  it('reserves and returns the sensor page resolved by the displayed screen', async () => {
    const { sessions, getScreen, useCase } = setup();
    getScreen.execute = async () => clampedSensorsScreen;

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'sensors', page: 12, checking: false },
    })).resolves.toMatchObject({
      kind: 'opened',
      view: { kind: 'sensors', page: 2, checking: false },
    });
    expect(sessions.reservation?.view).toEqual({ kind: 'sensors', page: 2, checking: false });
  });

  it('strips the prior keyboard only after the replacement has been promoted', async () => {
    const { sessions, delivery, protocolEvents, useCase } = setup();
    await active(sessions);
    sessions.calls.length = 0;
    delivery.calls.length = 0;
    protocolEvents.length = 0;

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'home', checking: false },
    })).resolves.toMatchObject({ kind: 'opened' });
    expect(protocolEvents).toEqual(['reserve', 'send', 'promote', 'stripKeyboard']);
    expect(delivery.calls[1]).toMatchObject({ kind: 'stripKeyboard', chatId: 70, messageId: 10 });
  });

  it('abandons the exact pending reservation and retains the old active Home when sending fails', async () => {
    const { sessions, delivery, useCase } = setup();
    await active(sessions);
    sessions.calls.length = 0;
    delivery.sendError = new Error('send failed');

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'home', checking: false },
    })).rejects.toThrow('send failed');
    expect(sessions.calls).toEqual(['reserve', 'abandon']);
    await expect(sessions.validate({ ...OLD, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', active: OLD,
    });
  });

  it('does not reserve when screen construction fails before delivery', async () => {
    const { sessions, delivery, getScreen, useCase } = setup();
    await active(sessions);
    sessions.calls.length = 0;
    getScreen.execute = async () => { throw new Error('summary unavailable'); };

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'home', checking: false },
    })).rejects.toThrow('summary unavailable');
    expect(sessions.calls).toEqual([]);
    expect(delivery.calls).toEqual([]);
    await expect(sessions.validate({ ...OLD, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', active: OLD,
    });
  });

  it('strips a newly sent losing message when a competing reservation wins promotion', async () => {
    const { sessions, delivery, useCase } = setup(['abcdefghijklmnop', 'qrstuvwxyzabcdef']);
    await active(sessions);
    delivery.onSend = async () => {
      await sessions.reserveNew({
        userId: 7,
        chatId: 70,
        token: 'qrstuvwxyzabcdef',
        view: { kind: 'home', checking: false },
        now: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
    };
    sessions.calls.length = 0;
    delivery.calls.length = 0;

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'home', checking: false },
    })).resolves.toEqual({ kind: 'superseded' });
    expect(delivery.calls.map(({ kind }) => kind)).toEqual(['send', 'stripKeyboard']);
    expect(delivery.calls[1]).toMatchObject({ kind: 'stripKeyboard', chatId: 70, messageId: 1 });
    await expect(sessions.validate({ ...OLD, now: NOW })).resolves.toMatchObject({
      kind: 'accepted', active: OLD,
    });
  });

  it('ignores keyboard-strip failure after a successful promotion', async () => {
    const { sessions, delivery, useCase } = setup();
    await active(sessions);
    delivery.stripKeyboardError = new Error('strip failed');

    await expect(useCase.execute({
      userId: 7, chatId: 70, locale: 'en', role: 'user',
      view: { kind: 'home', checking: false },
    })).resolves.toMatchObject({ kind: 'opened' });
  });
});
