import { Injectable } from '@nestjs/common';
import type { MonotonicClockPort } from '../domain/ports/monotonic-clock.port';

/** Process-local deterministic clock for stub/dev composition. */
@Injectable()
export class InMemoryMonotonicClockAdapter implements MonotonicClockPort {
  private elapsedMs = 0;

  now(): number {
    return this.elapsedMs;
  }

  advanceBy(milliseconds: number): void {
    this.elapsedMs += milliseconds;
  }
}
