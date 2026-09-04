import { Injectable } from '@nestjs/common';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';

/** Process-local, fail-closed fence shared by every live-view source kind. */
@Injectable()
export class LiveViewStartGate {
  private closed = true;
  private epoch = 0;

  close(): number {
    this.closed = true;
    return ++this.epoch;
  }

  openIfCurrent(epoch: number): boolean {
    if (epoch !== this.epoch) return false;
    this.closed = false;
    return true;
  }

  assertCanStart(): void {
    if (this.closed) throw new LiveStreamUnavailableError();
  }
}
