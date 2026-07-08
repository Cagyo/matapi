import { Inject, Injectable, Logger } from '@nestjs/common';
import { summarizeEvents } from '../domain/event-summary';
import { CLOCK, ClockPort } from '../domain/ports/clock.port';
import {
  EVENT_REPOSITORY,
  EventRepositoryPort,
} from '../domain/ports/event-repository.port';
import { NOTIFIER, NotifierPort } from '../domain/ports/notifier.port';
import {
  EVENT_QUEUE_OPTIONS,
  EventQueueOptions,
} from './ports/event-queue-options.port';

/**
 * Drains the unsent event queue at-least-once. Inter-batch pacing and
 * Telegram rate-limit handling are the notifier adapter's concern
 * (`@grammyjs/auto-retry`), not this use case — see spec 05.
 */
@Injectable()
export class DrainEventQueueUseCase {
  private readonly logger = new Logger(DrainEventQueueUseCase.name);
  private isDraining = false;

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: EventRepositoryPort,
    @Inject(NOTIFIER)
    private readonly notifier: NotifierPort,
    @Inject(CLOCK)
    private readonly clock: ClockPort,
    @Inject(EVENT_QUEUE_OPTIONS)
    private readonly options: EventQueueOptions,
  ) {}

  async execute(): Promise<void> {
    if (this.isDraining || !this.notifier.isReady()) return;

    this.isDraining = true;
    try {
      while (true) {
        const backlog = await this.eventRepository.countPending();
        if (backlog === 0) break;

        const batch = await this.eventRepository.pending(this.options.batchSize);
        if (batch.length === 0) break;

        const forceFile = backlog >= this.options.maxQueueBeforeForceAggregate;

        try {
          await this.notifier.notify({
            text: summarizeEvents(batch),
            asFile: forceFile,
          });
          await this.eventRepository.markSent(
            batch.map((event) => event.id),
            this.clock.now(),
          );
        } catch (error) {
          this.logger.warn(`Send failed, will retry: ${(error as Error).message}`);
          break;
        }
      }
    } finally {
      this.isDraining = false;
    }
  }
}
