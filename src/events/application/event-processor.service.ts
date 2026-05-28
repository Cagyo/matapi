import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventQueueService } from './event-queue.service';
import { DrainEventQueueUseCase } from './drain-event-queue.use-case';
import {
  SENSOR_EVENT_SOURCE,
  SensorEventSourcePort,
} from '../domain/ports/sensor-event-source.port';
import { SensorEvent } from '../domain/sensor-event';

@Injectable()
export class EventProcessorService implements OnModuleInit {
  private readonly logger = new Logger(EventProcessorService.name);

  constructor(
    private readonly eventQueue: EventQueueService,
    private readonly drainEventQueue: DrainEventQueueUseCase,
    @Inject(SENSOR_EVENT_SOURCE)
    private readonly sensorEvents: SensorEventSourcePort,
  ) {}

  onModuleInit(): void {
    this.sensorEvents.onEvent((event) => {
      void this.handle(event).catch((error) => {
        this.logger.error(`Event processing failed: ${(error as Error).message}`);
      });
    });
  }

  drain(): Promise<void> {
    return this.drainEventQueue.execute();
  }

  private async handle(event: SensorEvent): Promise<void> {
    const queued = await this.eventQueue.enqueueSensorEvent(event);
    this.logger.debug(`Queued event #${queued.id} for ${event.sensorId}`);
    await this.drain();
  }
}