import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { WATCHDOG, WatchdogPort } from '../domain/ports/watchdog.port';
import { WATCHDOG_ENABLED } from '../network.tokens';

const DEFAULT_PET_INTERVAL_MS = 15_000;

function resolvePetInterval(): number {
  const raw = Number(process.env.WATCHDOG_PET_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PET_INTERVAL_MS;
}

/**
 * Pets the Pi hardware watchdog on an interval (spec 22). Opens the device at
 * bootstrap, pets every `WATCHDOG_PET_INTERVAL_MS` (default 15s), and disarms
 * on clean shutdown. Inactive unless `HARDWARE_WATCHDOG_ENABLED=true` — on dev
 * hosts the stub adapter is bound and the loop never starts.
 */
@Injectable()
export class WatchdogService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WatchdogService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(WATCHDOG_ENABLED) private readonly enabled: boolean,
    @Inject(WATCHDOG) private readonly watchdog: WatchdogPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;

    await this.watchdog.open();
    const interval = resolvePetInterval();
    this.timer = setInterval(() => void this.pet(), interval);
    // Don't keep the event loop alive solely for the watchdog.
    this.timer.unref?.();
    this.logger.log(`Hardware watchdog pet loop active (every ${interval}ms)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.enabled) await this.watchdog.close();
  }

  private async pet(): Promise<void> {
    try {
      await this.watchdog.pet();
    } catch (err) {
      this.logger.warn(`Watchdog pet failed: ${(err as Error).message}`);
    }
  }
}
