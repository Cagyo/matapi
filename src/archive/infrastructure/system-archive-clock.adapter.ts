import { Inject, Injectable } from '@nestjs/common';
import type {
  ArchiveClockPort,
  ArchiveClockReading,
} from '../application/ports/archive-clock.port';
import {
  CLOCK_SYNC_PROBE,
  type ClockSyncProbePort,
} from '../../system/domain/ports/clock-sync.port';

const DEFAULT_PLAUSIBLE_AFTER_MS = Date.UTC(2020, 0, 1);
const DEFAULT_PLAUSIBLE_BEFORE_MS = Date.UTC(2100, 0, 1);
const DEFAULT_MAX_OFFSET_MS = 5 * 60 * 1_000;

export interface SystemArchiveClockOptions {
  now?: () => number;
  plausibleAfterMs?: number;
  plausibleBeforeMs?: number;
  maxOffsetMs?: number;
}

/** Combines the host synchronization probe with conservative wall-time bounds. */
@Injectable()
export class SystemArchiveClockAdapter implements ArchiveClockPort {
  private readonly now: () => number;
  private readonly plausibleAfterMs: number;
  private readonly plausibleBeforeMs: number;
  private readonly maxOffsetMs: number;

  constructor(
    @Inject(CLOCK_SYNC_PROBE)
    private readonly synchronization: ClockSyncProbePort,
    options: SystemArchiveClockOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.plausibleAfterMs = options.plausibleAfterMs ?? DEFAULT_PLAUSIBLE_AFTER_MS;
    this.plausibleBeforeMs = options.plausibleBeforeMs ?? DEFAULT_PLAUSIBLE_BEFORE_MS;
    this.maxOffsetMs = options.maxOffsetMs ?? DEFAULT_MAX_OFFSET_MS;
  }

  async read(): Promise<ArchiveClockReading> {
    const nowMs = this.now();
    const status = await this.synchronization.probe();
    const offsetShapeValid = status.offsetMs === null || (
      Number.isFinite(status.offsetMs) &&
      Number.isSafeInteger(status.offsetMs)
    );
    const offsetHealthy = offsetShapeValid && (
      status.offsetMs === null || Math.abs(status.offsetMs) <= this.maxOffsetMs
    );
    const shapeValid = typeof status.synchronized === 'boolean' && offsetShapeValid;
    const plausible = shapeValid && offsetHealthy &&
      Number.isSafeInteger(nowMs) &&
      nowMs >= this.plausibleAfterMs &&
      nowMs < this.plausibleBeforeMs;
    return {
      nowMs,
      synchronized: shapeValid ? status.synchronized : false,
      plausible,
      offsetMs: offsetShapeValid ? status.offsetMs : null,
    };
  }
}
