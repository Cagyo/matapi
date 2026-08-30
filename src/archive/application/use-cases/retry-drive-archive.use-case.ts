import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../events/domain/ports/clock.port';
import { ArchiveWakeService } from '../archive-wake.service';
import {
  DRIVE_FOLDER_RESERVATION_REPOSITORY,
  type DriveFolderReservationRepositoryPort,
} from '../ports/drive-folder-reservation-repository.port';
import {
  ARCHIVE_PROVIDER_STATE_REPOSITORY,
  type ArchiveProviderState,
  type ArchiveProviderStateRepositoryPort,
} from '../ports/archive-provider-state-repository.port';

export type RetryDriveArchiveResult =
  | 'scheduled'
  | 'stale'
  | 'nothing-blocked'
  | 'automatic-quota-probe'
  | 'reauthorize';

export interface RetryDriveArchiveInput {
  generationId: string;
  observedProviderRevision: number;
}

/** Schedules bounded recovery work without accepting a remote object or folder ID. */
@Injectable()
export class RetryDriveArchiveUseCase {
  constructor(
    @Inject(ARCHIVE_PROVIDER_STATE_REPOSITORY)
    private readonly providerState: ArchiveProviderStateRepositoryPort,
    @Inject(DRIVE_FOLDER_RESERVATION_REPOSITORY)
    private readonly reservations: Pick<
      DriveFolderReservationRepositoryPort,
      'requestNextBlockedRevalidation'
    >,
    @Inject(CLOCK) private readonly clock: Pick<ClockPort, 'now'>,
    private readonly wake: ArchiveWakeService,
  ) {}

  async execute(input: RetryDriveArchiveInput): Promise<RetryDriveArchiveResult> {
    const current = await this.providerState.load();
    if (current.generationId !== input.generationId
      || current.revision !== input.observedProviderRevision) return 'stale';

    if (current.blockReason === 'quota_exhausted') return 'automatic-quota-probe';
    if (current.blockReason === 'reauthorization_required') return 'reauthorize';
    if (current.blockReason === 'account_creation_limit'
      || current.blockReason === 'policy_blocked') {
      const scheduled = await this.providerState.requestProbe({
        generationId: input.generationId,
        expectedRevision: input.observedProviderRevision,
        allowedBlockReasons: [current.blockReason],
        nowMs: this.clock.now().getTime(),
      });
      if (!scheduled) return 'stale';
      this.wake.wake();
      return 'scheduled';
    }

    if (!isClear(current)) return 'nothing-blocked';
    const requested = await this.reservations.requestNextBlockedRevalidation({
      generationId: input.generationId,
      nowMs: this.clock.now().getTime(),
    });
    if (requested === null) return 'nothing-blocked';
    this.wake.wake();
    return 'scheduled';
  }
}

function isClear(state: ArchiveProviderState): boolean {
  return state.operationClass === null
    && state.failureClass === null
    && state.failureStreak === 0
    && state.cooldownUntilMs === null
    && state.blockReason === null;
}
