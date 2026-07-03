import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventNotifierService } from '../../events/application/event-notifier.service';
import { EventProcessorService } from '../../events/application/event-processor.service';
import { en } from '../../locales/en';

const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

/**
 * Ordered graceful-shutdown coordinator (spec 23 — Graceful Shutdown). Invoked
 * from the bootstrap signal handler before `app.close()` so the sequence is
 * deterministic rather than dependent on Nest hook ordering:
 *
 *   1. stop accepting new sensor events
 *   2. wait for in-flight event processing (bounded)
 *   3. send the "going offline" notice while the bot is still polling
 *
 * Module teardown (`app.close()`) then flushes buffered writes, stops the bot
 * runner and closes SQLite.
 */
@Injectable()
export class GracefulShutdownService {
  private readonly logger = new Logger(GracefulShutdownService.name);

  constructor(
    @Inject(forwardRef(() => EventProcessorService))
    private readonly eventProcessor: EventProcessorService,
    @Inject(forwardRef(() => EventNotifierService))
    private readonly notifier: EventNotifierService,
  ) {}

  async run(signal: string): Promise<void> {
    this.logger.log(`Graceful shutdown (${signal}) started`);

    this.eventProcessor.beginShutdown();
    await this.eventProcessor.waitForIdle(this.drainTimeoutMs());

    if (this.notifier.isReady()) {
      try {
        await this.notifier.notify({ text: en.system.goingOffline, asFile: false });
      } catch (err) {
        this.logger.warn(`Offline notice failed: ${(err as Error).message}`);
      }
    }
  }

  private drainTimeoutMs(): number {
    const raw = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DRAIN_TIMEOUT_MS;
  }
}
