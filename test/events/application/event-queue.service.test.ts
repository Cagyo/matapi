import { describe, expect, it } from 'vitest';
import { EventQueueService } from '../../../src/events/application/event-queue.service';
import {
  EventRepositoryPort,
} from '../../../src/events/domain/ports/event-repository.port';
import {
  NewQueuedEvent,
  QueuedEvent,
} from '../../../src/events/domain/queued-event.entity';
import { SensorEvent } from '../../../src/events/domain/sensor-event';

class RecordingEventRepository implements EventRepositoryPort {
  readonly enqueued: NewQueuedEvent[] = [];

  async enqueue(event: NewQueuedEvent): Promise<QueuedEvent> {
    this.enqueued.push(event);
    return { id: this.enqueued.length, ...event };
  }

  async pending(): Promise<QueuedEvent[]> {
    return [];
  }

  async markSent(): Promise<void> {}
}

function makeEvent(overrides: Partial<SensorEvent> = {}): SensorEvent {
  return {
    sensorId: 'front_door',
    type: 'state_change',
    oldValue: false,
    newValue: true,
    timestamp: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('EventQueueService', () => {
  it('stores state changes with old and new values', async () => {
    const repository = new RecordingEventRepository();
    const service = new EventQueueService(repository);

    const queued = await service.enqueueSensorEvent(makeEvent());

    expect(queued).toMatchObject({ id: 1, sensorId: 'front_door' });
    expect(repository.enqueued).toEqual([
      {
        sensorId: 'front_door',
        type: 'state_change',
        payload: { oldValue: false, newValue: true },
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('stores non-state sensor events as system queue entries', async () => {
    const repository = new RecordingEventRepository();
    const service = new EventQueueService(repository);

    await service.enqueueSensorEvent(
      makeEvent({ type: 'error', oldValue: undefined, newValue: 'offline' }),
    );

    expect(repository.enqueued[0]).toMatchObject({
      sensorId: 'front_door',
      type: 'system',
      payload: { oldValue: undefined, newValue: 'offline' },
    });
  });
});