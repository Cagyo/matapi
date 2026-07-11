import { describe, expect, it } from 'vitest';
import { DrainEventQueueUseCase } from '../../../src/events/application/drain-event-queue.use-case';
import { EventQueueOptions } from '../../../src/events/application/ports/event-queue-options.port';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import {
  NotificationMessage,
  NotificationPhoto,
  NotifierPort,
} from '../../../src/events/domain/ports/notifier.port';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

class RecordingNotifier implements NotifierPort {
  ready = true;
  fail = false;
  readonly messages: NotificationMessage[] = [];

  isReady(): boolean {
    return this.ready;
  }

  async notify(message: NotificationMessage): Promise<void> {
    this.messages.push(message);
    if (this.fail) {
      throw new Error('telegram offline');
    }
  }

  async notifyUser(_telegramId: number, message: NotificationMessage): Promise<void> {
    this.messages.push(message);
    if (this.fail) {
      throw new Error('telegram offline');
    }
  }

  async notifyUserPhoto(
    _telegramId: number,
    _photo: NotificationPhoto,
  ): Promise<void> {
    if (this.fail) {
      throw new Error('telegram offline');
    }
  }
}

const baseOptions: EventQueueOptions = {
  batchSize: 50,
  maxQueueBeforeForceAggregate: 100,
  maxUnsentEvents: 500,
};

function makeUseCase(options: Partial<EventQueueOptions> = {}) {
  const repository = new InMemoryEventRepository();
  const notifier = new RecordingNotifier();
  const sentAt = new Date('2030-01-01T00:00:00.000Z');
  const clock: ClockPort = { now: () => sentAt };
  const useCase = new DrainEventQueueUseCase(repository, notifier, clock, {
    ...baseOptions,
    ...options,
  });

  return { repository, notifier, sentAt, useCase };
}

describe('DrainEventQueueUseCase', () => {
  it('sends one event summary and marks it sent with the clock time', async () => {
    const { repository, notifier, sentAt, useCase } = makeUseCase();
    const queued = await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });

    await useCase.execute();

    expect(notifier.messages).toEqual([
      {
        text: '2029-12-31T23:59:00.000Z — front_door true',
        asFile: false,
      },
    ]);
    expect(await repository.pending()).toHaveLength(0);
    expect(repository.sentAtFor(queued.id)).toBe(sentAt);
  });

  it('aggregates multiple events into one notification', async () => {
    const { repository, notifier, useCase } = makeUseCase();
    await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });
    await repository.enqueue({
      sensorId: null,
      type: 'system',
      payload: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await useCase.execute();

    expect(notifier.messages).toEqual([
      {
        text:
          '📋 Offline events (2029-12-31T23:59:00.000Z — 2030-01-01T00:00:00.000Z):\n\n' +
          '2029-12-31T23:59:00.000Z — front_door true\n' +
          '2030-01-01T00:00:00.000Z — system system',
        asFile: false,
      },
    ]);
  });

  it('requests file delivery when the batch reaches the force threshold', async () => {
    const { repository, notifier, useCase } = makeUseCase({
      maxQueueBeforeForceAggregate: 2,
    });
    await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });
    await repository.enqueue({
      sensorId: 'back_door',
      type: 'state_change',
      payload: { newValue: false },
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await useCase.execute();

    expect(notifier.messages[0].asFile).toBe(true);
  });

  it('keeps draining until no pending events remain', async () => {
    const { repository, notifier, useCase } = makeUseCase({ batchSize: 1 });
    await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });
    await repository.enqueue({
      sensorId: 'back_door',
      type: 'state_change',
      payload: { newValue: false },
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await useCase.execute();

    expect(notifier.messages).toHaveLength(2);
    expect(await repository.pending()).toEqual([]);
  });

  it('leaves events pending after send failure so a later drain can retry', async () => {
    const { repository, notifier, useCase } = makeUseCase();
    const queued = await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });

    notifier.fail = true;
    await useCase.execute();

    expect((await repository.pending()).map((event) => event.id)).toEqual([queued.id]);
    expect(repository.sentAtFor(queued.id)).toBeNull();

    notifier.fail = false;
    await useCase.execute();

    expect(await repository.pending()).toHaveLength(0);
    expect(notifier.messages).toHaveLength(2);
  });

  it('does not drain when the notifier is not ready', async () => {
    const { repository, notifier, useCase } = makeUseCase();
    await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });

    notifier.ready = false;
    await useCase.execute();

    expect(notifier.messages).toHaveLength(0);
    expect(await repository.pending()).toHaveLength(1);
  });

  it('forces file delivery based on total backlog, not batch size', async () => {
    const { repository, notifier, useCase } = makeUseCase({
      batchSize: 1,
      maxQueueBeforeForceAggregate: 2,
    });
    await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { newValue: true },
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });
    await repository.enqueue({
      sensorId: 'back_door',
      type: 'state_change',
      payload: { newValue: false },
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await useCase.execute();

    // First batch carried only 1 event, but the backlog was 2 (>= threshold),
    // so delivery is still forced to a file.
    expect(notifier.messages[0].asFile).toBe(true);
  });
});
