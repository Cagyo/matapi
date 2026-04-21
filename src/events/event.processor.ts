import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventQueue, QueuedEvent } from './event.queue';
import { SensorRegistry } from '../sensors/sensor.registry';
import { SensorEvent } from '../sensors/sensor.interface';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drains pending events to Telegram. Sender is injected from the bot module
 * via `setSender()` so this module has no hard dependency on grammY.
 */
@Injectable()
export class EventProcessor implements OnModuleInit {
  private readonly logger = new Logger(EventProcessor.name);
  private sender?: (text: string, asFile?: boolean) => Promise<void>;
  private draining = false;

  constructor(
    private readonly queue: EventQueue,
    private readonly sensors: SensorRegistry,
  ) {}

  setSender(sender: (text: string, asFile?: boolean) => Promise<void>): void {
    this.sender = sender;
  }

  onModuleInit(): void {
    this.sensors.onEvent((event) => this.handle(event));
  }

  private handle(event: SensorEvent): void {
    const queued = this.queue.enqueue(event);
    this.logger.debug(`Queued event #${queued.id} for ${event.sensorId}`);
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.draining || !this.sender) return;
    this.draining = true;
    try {
      while (true) {
        const batch = this.queue.pending(50);
        if (batch.length === 0) break;

        const forceFile =
          batch.length >= Number(process.env.MAX_QUEUE_BEFORE_FORCE_AGGREGATE || 100);

        const summary = this.aggregate(batch);
        try {
          await this.sender(summary, forceFile);
          this.queue.markSent(batch.map((b) => b.id));
        } catch (err) {
          this.logger.warn(`Send failed, will retry: ${(err as Error).message}`);
          break;
        }
        await sleep(2000);
      }
    } finally {
      this.draining = false;
    }
  }

  private aggregate(batch: QueuedEvent[]): string {
    if (batch.length === 1) {
      const e = batch[0];
      return `${this.fmt(e.createdAt)} — ${e.sensorId ?? 'system'} ${e.type}`;
    }
    const lines = batch.map(
      (e) => `${this.fmt(e.createdAt)} — ${e.sensorId ?? 'system'} ${e.type}`,
    );
    return `📋 Events (${batch.length}):\n\n${lines.join('\n')}`;
  }

  private fmt(d: Date | null): string {
    return d ? d.toISOString() : '—';
  }
}
