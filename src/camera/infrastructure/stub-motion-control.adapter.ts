import { Injectable, Logger } from '@nestjs/common';
import { MotionAlreadyRunningError } from '../domain/errors/motion-already-running.error';
import { MotionControlPort } from '../domain/ports/motion-control.port';

/**
 * Dev/test `MotionControlPort`. Holds the daemon state in memory so the
 * `/camera` commands work locally without systemd. Defaults to "running"
 * so `/camera snapshot` succeeds out of the box.
 */
@Injectable()
export class StubMotionControlAdapter implements MotionControlPort {
  private readonly logger = new Logger(StubMotionControlAdapter.name);
  private running = true;

  async isActive(): Promise<boolean> {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) throw new MotionAlreadyRunningError();
    this.running = true;
    this.logger.warn('StubMotionControlAdapter: motion "started"');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.logger.warn('StubMotionControlAdapter: motion "stopped"');
  }

  async restart(): Promise<void> {
    this.running = true;
    this.logger.warn('StubMotionControlAdapter: motion "restarted"');
  }
}
