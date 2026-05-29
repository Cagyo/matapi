import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ClockSyncProbePort,
  ClockSyncStatus,
} from '../domain/ports/clock-sync.port';

const execAsync = promisify(exec);

/**
 * `ClockSyncProbePort` for systemd hosts (spec 23). Reads `timedatectl` to
 * learn whether the clock is NTP-synchronised. On platforms without
 * `timedatectl` (macOS dev boxes) it degrades to `synchronized: false` with a
 * `null` offset rather than throwing — mirroring `OsSystemHealthAdapter`.
 */
@Injectable()
export class TimedatectlClockSyncAdapter implements ClockSyncProbePort {
  private readonly logger = new Logger(TimedatectlClockSyncAdapter.name);

  async probe(): Promise<ClockSyncStatus> {
    try {
      const { stdout } = await execAsync(
        'timedatectl show -p NTPSynchronized --value',
        { timeout: 5000 },
      );
      return { synchronized: stdout.trim() === 'yes', offsetMs: null };
    } catch (err) {
      this.logger.debug?.(`timedatectl unavailable: ${(err as Error).message}`);
      return { synchronized: false, offsetMs: null };
    }
  }
}
