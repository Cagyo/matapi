import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { MonotonicClockPort } from '../domain/ports/monotonic-clock.port';

@Injectable()
export class SystemMonotonicClockAdapter implements MonotonicClockPort {
  now(): number {
    return performance.now();
  }
}
