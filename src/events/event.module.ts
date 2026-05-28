import { Module } from '@nestjs/common';
import { SensorModule } from '../sensors/sensor.module';
import { SensorRegistry } from '../sensors/sensor.registry';
import { DrainEventQueueUseCase } from './application/drain-event-queue.use-case';
import { EventNotifierService } from './application/event-notifier.service';
import { EventProcessorService } from './application/event-processor.service';
import { EventQueueService } from './application/event-queue.service';
import {
  EVENT_QUEUE_OPTIONS,
  EventQueueOptions,
} from './application/ports/event-queue-options.port';
import { CLOCK } from './domain/ports/clock.port';
import { EVENT_REPOSITORY } from './domain/ports/event-repository.port';
import { NOTIFIER } from './domain/ports/notifier.port';
import { SENSOR_EVENT_SOURCE } from './domain/ports/sensor-event-source.port';
import { DrizzleEventRepository } from './infrastructure/drizzle-event.repository';
import { SystemClockAdapter } from './infrastructure/system-clock.adapter';

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [SensorModule],
  providers: [
    DrainEventQueueUseCase,
    EventNotifierService,
    EventProcessorService,
    EventQueueService,
    { provide: CLOCK, useClass: SystemClockAdapter },
    { provide: EVENT_REPOSITORY, useClass: DrizzleEventRepository },
    { provide: NOTIFIER, useExisting: EventNotifierService },
    { provide: SENSOR_EVENT_SOURCE, useExisting: SensorRegistry },
    {
      provide: EVENT_QUEUE_OPTIONS,
      useFactory: (): EventQueueOptions => ({
        batchSize: 50,
        maxQueueBeforeForceAggregate: positiveIntegerFromEnv(
          process.env.MAX_QUEUE_BEFORE_FORCE_AGGREGATE,
          100,
        ),
        drainDelayMs: 2000,
      }),
    },
  ],
  exports: [EventNotifierService, EventProcessorService, EventQueueService],
})
export class EventModule {}
