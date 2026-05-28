import { Inject, Injectable } from '@nestjs/common';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
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
    @Inject(SENSOR_QUERY)
    private readonly sensorQuery: SensorQueryPort,
  ) {}

  async enqueueSensorEvent(event: SensorEvent): Promise<QueuedEvent> {
    const sensor = await this.sensorQuery.findById(event.sensorId);
    return this.eventRepository.enqueue({
      sensorId: event.sensorId,
      type: event.type === 'state_change' ? 'state_change' : 'system',
      payload: {
        oldValue: event.oldValue ?? null,
        newValue: event.newValue,
        name: sensor?.name ?? null,
        severity: sensor?.severity ?? null,
      },
      createdAt: event.timestamp,
    });
  }
}