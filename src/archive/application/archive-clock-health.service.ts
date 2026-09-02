import { Inject, Injectable } from '@nestjs/common';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
  type ArchiveClockHealth,
  type ArchiveSchedulerUpdate,
} from './ports/archive-artifact-repository.port';
import {
  ArchiveWakeService,
  DEFAULT_ARCHIVE_WAKE_SERVICE,
} from './archive-wake.service';

const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60_000;

/** Durable, revision-fenced wall-clock plausibility gate for archive work. */
@Injectable()
export class ArchiveClockHealthService {
  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'readSchedulerState' | 'compareAndSetSchedulerState'>,
    private readonly wake: ArchiveWakeService = DEFAULT_ARCHIVE_WAKE_SERVICE,
  ) {}

  async check(nowMs: number): Promise<ArchiveClockHealth> {
    requireEpoch(nowMs);
    for (;;) {
      const current = await this.repository.readSchedulerState();
      const baseline = current.lastPlausibleWallTimeMs;
      const rollbackMs = baseline === null ? 0 : baseline - nowMs;
      const nextHealth: ArchiveClockHealth = rollbackMs > CLOCK_ROLLBACK_TOLERANCE_MS
        ? 'clock-blocked'
        : 'healthy';
      const update: ArchiveSchedulerUpdate = nextHealth === 'clock-blocked'
        ? {
            clockHealth: nextHealth,
            observedRollbackMs: Math.max(rollbackMs, current.observedRollbackMs ?? 0),
          }
        : {
            clockHealth: nextHealth,
            observedRollbackMs: null,
            lastPlausibleWallTimeMs: Math.max(baseline ?? 0, nowMs),
          };

      if (await this.repository.compareAndSetSchedulerState(current.revision, update)) {
        if (current.clockHealth !== nextHealth) this.wake.wake();
        return nextHealth;
      }
    }
  }
}

function requireEpoch(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Archive wall-clock epoch is invalid');
  }
}
