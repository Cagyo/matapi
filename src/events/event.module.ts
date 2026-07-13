import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { loadDefaults } from '../config/config.loader';
import {
  TIMEZONE_OPTIONS,
  TimezoneOptions,
} from '../config/application/ports/timezone-options.port';
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
  EVENT_PROCESSOR_OPTIONS,
  EventProcessorOptions,
} from './application/ports/event-processor-options.port';
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
import { eventProcessorOptionsFromEnv } from './infrastructure/env-event-processor-options';
import { eventQueueOptionsFromEnv } from './infrastructure/env-event-queue-options';
import { criticalBypassDeprecationWarning } from './infrastructure/env-critical-bypass';
import { SystemClockAdapter } from './infrastructure/system-clock.adapter';

@Module({
  imports: [ConfigModule, SensorModule],
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
      provide: EVENT_PROCESSOR_OPTIONS,
      useFactory: (): EventProcessorOptions => eventProcessorOptionsFromEnv(),
    },
    {
      provide: EVENT_QUEUE_OPTIONS,
      useFactory: (): EventQueueOptions => eventQueueOptionsFromEnv(loadDefaults().notifications),
    },
    {
      provide: NOTIFICATION_OPTIONS,
      useFactory: (timezoneOptions: TimezoneOptions): NotificationOptions => {
        const warning = criticalBypassDeprecationWarning(process.env);
        if (warning) new Logger('EventModule').warn(warning);
        return { timezone: timezoneOptions.timezone };
      },
      inject: [TIMEZONE_OPTIONS],
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
