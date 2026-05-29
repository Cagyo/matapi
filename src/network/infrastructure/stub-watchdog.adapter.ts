import { Injectable, Logger } from '@nestjs/common';
import { WatchdogPort } from '../domain/ports/watchdog.port';

/**
 * No-op `WatchdogPort` for hosts without a watchdog device (dev machines, or
 * `HARDWARE_WATCHDOG_ENABLED` unset). Keeps the wiring uniform so application
 * code never branches on whether a real device is present.
 */
@Injectable()
export class StubWatchdogAdapter implements WatchdogPort {
  private readonly logger = new Logger(StubWatchdogAdapter.name);

  async open(): Promise<void> {
    this.logger.debug('Hardware watchdog disabled (stub)');
  }

  async pet(): Promise<void> {
    /* no-op */
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
