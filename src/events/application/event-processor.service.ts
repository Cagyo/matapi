import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventQueueService } from './event-queue.service';
import { DrainEventQueueUseCase } from './drain-event-queue.use-case';
import { NotificationService } from './notification.service';
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

  constructor(
    private readonly eventQueue: EventQueueService,
    private readonly drainEventQueue: DrainEventQueueUseCase,
    private readonly notifications: NotificationService,
    @Inject(SENSOR_EVENT_SOURCE)
    private readonly sensorEvents: SensorEventSourcePort,
  ) {}

  onModuleInit(): void {
    this.sensorEvents.onEvent((event) => {
      if (this.shuttingDown) return;
      this.inFlight += 1;
      void this.handle(event)
        .catch((error) => {
          this.logger.error(`Event processing failed: ${(error as Error).message}`);
        })
        .finally(() => {
          this.inFlight -= 1;
        });
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
   * Resolve once no events are mid-flight, or after `timeoutMs` (spec 23 —
   * Graceful Shutdown step 3). Bounded so shutdown never hangs.
   */
  async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.inFlight > 0) {
      this.logger.warn(`Shutdown timeout — ${this.inFlight} event(s) still in flight`);
    }
  }

  private async handle(event: SensorEvent): Promise<void> {
    const queued = await this.eventQueue.enqueueSensorEvent(event);
    this.logger.debug(`Queued event #${queued.id} for ${event.sensorId}`);
    await this.notifications.process(queued);
  }
}