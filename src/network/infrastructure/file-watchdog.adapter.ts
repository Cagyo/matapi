import { Injectable, Logger } from '@nestjs/common';
import { open, type FileHandle } from 'node:fs/promises';
import { WatchdogPort } from '../domain/ports/watchdog.port';

const DEFAULT_DEVICE = '/dev/watchdog';

/**
 * `WatchdogPort` backed by the Linux watchdog character device. Petting writes
 * a byte to defer the reboot; closing writes the magic `V` to disarm so a
 * clean shutdown does not reboot the Pi (spec 22). Selected only when
 * `HARDWARE_WATCHDOG_ENABLED=true`.
 */
@Injectable()
export class FileWatchdogAdapter implements WatchdogPort {
  private readonly logger = new Logger(FileWatchdogAdapter.name);
  private handle?: FileHandle;

  constructor(
    private readonly device: string = process.env.WATCHDOG_DEVICE ||
      DEFAULT_DEVICE,
  ) {}

  async open(): Promise<void> {
    this.handle = await open(this.device, 'w');
    this.logger.log(`Hardware watchdog armed (${this.device})`);
  }

  async pet(): Promise<void> {
    if (!this.handle) return;
    await this.handle.write('1');
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    try {
      // Magic close: disarm the watchdog so we don't reboot on clean exit.
      await this.handle.write('V');
    } finally {
      await this.handle.close();
      this.handle = undefined;
      this.logger.log('Hardware watchdog disarmed');
    }
  }
}
