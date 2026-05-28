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
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorQuery } from '../../../src/sensors/infrastructure/in-memory-sensor.query';

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

function makeSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: 'front_door',
    name: 'Front door',
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 10000,
    severity: 'warning',
    lastValue: null,
    lastValueAt: null,
    ...overrides,
  };
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
  it('enriches state changes with sensor name and severity', async () => {
    const repository = new RecordingEventRepository();
    const sensorQuery = new InMemorySensorQuery([makeSensor()]);
    const service = new EventQueueService(repository, sensorQuery);

    const queued = await service.enqueueSensorEvent(makeEvent());

    expect(queued).toMatchObject({ id: 1, sensorId: 'front_door' });
    expect(repository.enqueued).toEqual([
      {
        sensorId: 'front_door',
        type: 'state_change',
        payload: {
          oldValue: false,
          newValue: true,
          name: 'Front door',
          severity: 'warning',
        },
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('stores non-state sensor events as system queue entries', async () => {
    const repository = new RecordingEventRepository();
    const sensorQuery = new InMemorySensorQuery([makeSensor()]);
    const service = new EventQueueService(repository, sensorQuery);

    await service.enqueueSensorEvent(
      makeEvent({ type: 'error', oldValue: undefined, newValue: 'offline' }),
    );

    expect(repository.enqueued[0]).toMatchObject({
      sensorId: 'front_door',
      type: 'system',
      payload: {
        oldValue: null,
        newValue: 'offline',
        name: 'Front door',
        severity: 'warning',
      },
    });
  });

  it('falls back to null metadata when the sensor cannot be resolved', async () => {
    const repository = new RecordingEventRepository();
    const sensorQuery = new InMemorySensorQuery([]);
    const service = new EventQueueService(repository, sensorQuery);

    await service.enqueueSensorEvent(makeEvent());

    expect(repository.enqueued[0].payload).toEqual({
      oldValue: false,
      newValue: true,
      name: null,
      severity: null,
    });
  });
});
