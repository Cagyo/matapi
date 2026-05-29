import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  HEARTBEAT_CLIENT,
  HeartbeatClientPort,
} from '../domain/ports/heartbeat-client.port';

const DEFAULT_INTERVAL_MS = 300_000;

function resolveInterval(): number {
  const raw = Number(process.env.HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * Drives the external heartbeat ping on an interval (spec 22). A failure is
 * informational only — logged via Nest's Logger, never thrown — so a flaky
 * monitor never crashes the worker. The actual HTTP call and the no-op when
 * `HEARTBEAT_URL` is unset live in the adapter.
 */
@Injectable()
export class HeartbeatSchedulerService {
  private readonly logger = new Logger(HeartbeatSchedulerService.name);

  constructor(
    @Inject(HEARTBEAT_CLIENT) private readonly client: HeartbeatClientPort,
  ) {}

  @Interval('external-heartbeat', resolveInterval())
  tick(): void {
    void this.beat();
  }

  async beat(): Promise<void> {
    try {
      await this.client.pingExternal();
    } catch (err) {
      this.logger.warn(`Heartbeat failed: ${(err as Error).message}`);
    }
  }
}
