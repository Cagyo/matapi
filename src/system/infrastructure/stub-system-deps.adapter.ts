import { Injectable, Logger } from '@nestjs/common';
import {
  SystemDepsCheck,
  SystemDepsPort,
} from '../domain/ports/system-deps.port';

/**
 * Dev/stub `SystemDepsPort` implementation.
 *
 * Avoids running `sudo apt-get update`, `apt-cache policy`, or spawning
 * `scripts/system-update.sh` on dev hosts and during E2E tests.
 */
@Injectable()
export class StubSystemDepsAdapter implements SystemDepsPort {
  private readonly logger = new Logger(StubSystemDepsAdapter.name);

  async check(): Promise<SystemDepsCheck> {
    this.logger.debug('StubSystemDepsAdapter check() called');
    return {
      deps: [
        { name: 'motion', current: '4.3.2', available: '4.3.2', kind: 'none' },
        { name: 'ffmpeg', current: '6.0.0', available: '6.0.0', kind: 'none' },
        { name: 'mosquitto', current: '2.0.15', available: '2.0.15', kind: 'none' },
        { name: 'rclone', current: '1.65.0', available: '1.65.0', kind: 'none' },
        { name: 'node', current: '20.18.0', available: '20.18.0', kind: 'none' },
      ],
      hasUpdates: false,
      nodeMajorMismatch: false,
    };
  }

  async applyUpdate(): Promise<void> {
    this.logger.log('StubSystemDepsAdapter applyUpdate() called (simulating update)');
  }
}
