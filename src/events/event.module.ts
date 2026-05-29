import { Module } from '@nestjs/common';
import { SensorRegistryService } from '../sensors/application/sensor-registry.service';
import { SensorModule } from '../sensors/sensor.module';
import { DebounceService } from './application/debounce.service';
import { DrainEventQueueUseCase } from './application/drain-event-queue.use-case';
import { EventNotifierService } from './application/event-notifier.service';
import { EventProcessorService } from './application/event-processor.service';
import { EventQueueService } from './application/event-queue.service';
import { NotificationService } from './application/notification.service';
import { RecipientDirectoryService } from './application/recipient-directory.service';
import {
  EVENT_QUEUE_OPTIONS,
  EventQueueOptions,
} from './application/ports/event-queue-options.port';
import {
  NOTIFICATION_OPTIONS,
  NotificationOptions,
} from './application/ports/notification-options.port';
import { CLOCK } from './domain/ports/clock.port';
import { EVENT_REPOSITORY } from './domain/ports/event-repository.port';
import { NOTIFIER } from './domain/ports/notifier.port';
import { RECIPIENT_DIRECTORY } from './domain/ports/recipient.port';
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
    DebounceService,
    DrainEventQueueUseCase,
    EventNotifierService,
    EventProcessorService,
    EventQueueService,
    NotificationService,
    RecipientDirectoryService,
    { provide: CLOCK, useClass: SystemClockAdapter },
    { provide: EVENT_REPOSITORY, useClass: DrizzleEventRepository },
    { provide: NOTIFIER, useExisting: EventNotifierService },
    { provide: RECIPIENT_DIRECTORY, useExisting: RecipientDirectoryService },
    { provide: SENSOR_EVENT_SOURCE, useExisting: SensorRegistryService },
    {
      provide: EVENT_QUEUE_OPTIONS,
      useFactory: (): EventQueueOptions => ({
        batchSize: 50,
        maxQueueBeforeForceAggregate: positiveIntegerFromEnv(
          process.env.MAX_QUEUE_BEFORE_FORCE_AGGREGATE,
          100,
        ),
      }),
    },
    {
      provide: NOTIFICATION_OPTIONS,
      useFactory: (): NotificationOptions => ({
        timezone: process.env.TIMEZONE || 'Europe/Kyiv',
      }),
    },
  ],
  exports: [
    EventNotifierService,
    EventProcessorService,
    EventQueueService,
    NotificationService,
    RecipientDirectoryService,
    CLOCK,
  ],
})
export class EventModule {}
