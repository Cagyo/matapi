import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { BotRunnerRegistry } from './bot-runner.registry';

/** A bot is considered stalled if no update arrives within this window. */
const STALL_THRESHOLD_MS = 120_000;
/** How often to check polling health. */
const CHECK_INTERVAL_MS = 30_000;

/**
 * Bot polling watchdog (spec 22). grammY can believe it is still polling after
 * WiFi drops and reconnects (half-open TCP socket): the runner reports running
 * but no updates arrive. Every 30s this service checks update freshness and,
 * if stalled, force-restarts the runner. A failed restart is logged and
 * retried on the next tick (~30s).
 */
@Injectable()
export class CheckBotPollingService {
  private readonly logger = new Logger(CheckBotPollingService.name);

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly runner: BotRunnerRegistry,
  ) {}

  @Interval('bot-polling-check', CHECK_INTERVAL_MS)
  checkTick(): void {
    void this.check();
  }

  async check(): Promise<void> {
    // No runner registered (mock mode / pre-bootstrap) — nothing to watch.
    if (!this.runner.hasRunner()) return;
    if (this.isBotPollingHealthy()) return;

    this.logger.warn('Bot polling appears stalled — restarting grammY runner');
    try {
      await this.runner.restart();
    } catch (err) {
      this.logger.error(
        `grammY runner restart failed, retrying next tick: ${(err as Error).message}`,
      );
    }
  }

  isBotPollingHealthy(): boolean {
    const last = this.runner.getLastUpdateAt();
    // No update yet (freshly started, or a quiet bot that hasn't polled an
    // update) — treat as healthy to avoid restarting a working runner.
    if (!last) return true;
    return this.clock.now().getTime() - last.getTime() < STALL_THRESHOLD_MS;
  }
}
