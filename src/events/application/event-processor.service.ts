import { Inject, Injectable, Logger, OnModuleInit, forwardRef } from '@nestjs/common';
import { EventQueueService } from './event-queue.service';
import { DrainEventQueueUseCase } from './drain-event-queue.use-case';
import { NotificationService } from './notification.service';
import {
  EVENT_PROCESSOR_OPTIONS,
  EventProcessorOptions,
} from './ports/event-processor-options.port';
import {
  SENSOR_EVENT_SOURCE,
  SensorEventSourcePort,
} from '../domain/ports/sensor-event-source.port';
import { SensorEvent } from '../domain/sensor-event';

@Injectable()
export class EventProcessorService implements OnModuleInit {
  private readonly logger = new Logger(EventProcessorService.name);
  private shuttingDown = false;
  private inFlight = 0;
  private readonly pending: SensorEvent[] = [];
  private droppedPending = 0;

  constructor(
    @Inject(forwardRef(() => EventQueueService))
    private readonly eventQueue: EventQueueService,
    @Inject(forwardRef(() => DrainEventQueueUseCase))
    private readonly drainEventQueue: DrainEventQueueUseCase,
    @Inject(forwardRef(() => NotificationService))
    private readonly notifications: NotificationService,
    @Inject(SENSOR_EVENT_SOURCE)
    private readonly sensorEvents: SensorEventSourcePort,
    @Inject(EVENT_PROCESSOR_OPTIONS)
    private readonly options: EventProcessorOptions,
  ) {}

  onModuleInit(): void {
    this.sensorEvents.onEvent((event) => {
      if (this.shuttingDown) return; // stop accepting new work (spec 23)
      if (this.pending.length >= this.options.maxPendingEvents) {
        this.pending.shift();
        this.droppedPending += 1;
        this.logPendingDrop();
      }
      this.pending.push(event);
      this.pump();
    });
  }

  drain(): Promise<void> {
    return this.drainEventQueue.execute();
  }

  /** Stop accepting new sensor events (spec 23 — Graceful Shutdown step 1-2). */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Resolve once no events are mid-flight or queued, or after `timeoutMs`
   * (spec 23 — Graceful Shutdown step 3). Bounded so shutdown never hangs.
   */
  async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.inFlight > 0 || this.pending.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const outstanding = this.inFlight + this.pending.length;
    if (outstanding > 0) {
      this.logger.warn(`Shutdown timeout — ${outstanding} event(s) still outstanding`);
    }
  }

  /** Start handlers up to the concurrency cap; already-queued work drains even during shutdown. */
  private pump(): void {
    while (this.inFlight < this.options.maxConcurrent && this.pending.length > 0) {
      const event = this.pending.shift()!;
      this.inFlight += 1;
      void this.handle(event)
        .catch((error) => {
          this.logger.error(`Event processing failed: ${(error as Error).message}`);
        })
        .finally(() => {
          this.inFlight -= 1;
          this.pump();
        });
    }
  }

  private async handle(event: SensorEvent): Promise<void> {
    const queued = await this.eventQueue.enqueueSensorEvent(event);
    this.logger.debug(`Queued event #${queued.id} for ${event.sensorId}`);
    await this.notifications.process(queued);
  }

  private logPendingDrop(): void {
    if (!isPowerOfTwo(this.droppedPending)) return;
    this.logger.warn(
      `Dropped pending events: ${this.droppedPending}; configured pending bound: ${this.options.maxPendingEvents}`,
    );
  }
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && Number.isInteger(Math.log2(value));
}
