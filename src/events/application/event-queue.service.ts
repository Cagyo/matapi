import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_REPOSITORY,
  EventRepositoryPort,
} from '../domain/ports/event-repository.port';
import { QueuedEvent } from '../domain/queued-event.entity';
import { SensorEvent } from '../domain/sensor-event';

@Injectable()
export class EventQueueService {
  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: EventRepositoryPort,
  ) {}

  enqueueSensorEvent(event: SensorEvent): Promise<QueuedEvent> {
    return this.eventRepository.enqueue({
      sensorId: event.sensorId,
      type: event.type === 'state_change' ? 'state_change' : 'system',
      payload: {
        oldValue: event.oldValue,
        newValue: event.newValue,
      },
      createdAt: event.timestamp,
    });
  }
}