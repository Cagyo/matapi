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
const WATCHDOG_OPEN_FAILED = 'WATCHDOG_OPEN_FAILED';
const SAFE_FAILURE_CODE = /^[A-Za-z0-9_]{1,64}$/;

function resolvePetInterval(): number {
  const raw = Number(process.env.WATCHDOG_PET_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PET_INTERVAL_MS;
}

/**
 * Path-free discriminator for the one-shot open failure. Node errno codes
 * (`EACCES`, `EBUSY`, `ENODEV`) and domain error codes are safe by
 * construction; the character guard rejects anything else, which is how a
 * code carrying a device path degrades to the fixed token.
 */
function openFailureCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : null;
  const candidate = code
    ?? (error instanceof Error && error.name !== 'Error' ? error.name : null);
  return candidate !== null && SAFE_FAILURE_CODE.test(candidate)
    ? candidate
    : WATCHDOG_OPEN_FAILED;
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
  private opened = false;

  constructor(
    @Inject(WATCHDOG_ENABLED) private readonly enabled: boolean,
    @Inject(WATCHDOG) private readonly watchdog: WatchdogPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.watchdog.open();
    } catch (error) {
      // A device that will not open costs the Pi its hardware reset safety
      // net for the whole process lifetime, and nothing retries the open —
      // hence error, not warn. It must still not take the worker down with
      // it: Telegram, sensors and the archive do not depend on the watchdog.
      this.logger.error(`Hardware watchdog inactive: ${openFailureCode(error)}`);
      return;
    }
    this.opened = true;
    const interval = resolvePetInterval();
    this.timer = setInterval(() => void this.pet(), interval);
    // Don't keep the event loop alive solely for the watchdog.
    this.timer.unref?.();
    this.logger.log(`Hardware watchdog pet loop active (every ${interval}ms)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.opened) return;
    this.opened = false;
    await this.watchdog.close();
  }

  private async pet(): Promise<void> {
    try {
      await this.watchdog.pet();
    } catch (err) {
      this.logger.warn(`Watchdog pet failed: ${(err as Error).message}`);
    }
  }
}
